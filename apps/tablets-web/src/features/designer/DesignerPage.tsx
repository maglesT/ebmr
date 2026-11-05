/**
 * The designer of one MBR version (module C2; plan section 8, screens 6-8): toolbar, the document view and the side
 * panel (findings, step properties, simulation).
 *
 * Editing happens in the browser on a copy of the saved revision (pure operations with undo and redo); the server
 * validates every change (debounced) and saves a revision only when the author saves with a change note, based on
 * the revision the edits started from (409 when someone saved meanwhile). Unsaved edits are kept as a local draft
 * of the signed-in person (decision D7) and, when restored, shown as UNSAVED until saved. A draft is offered only to
 * the person who made it, and only while the version is a DRAFT: a version that can no longer be edited always shows
 * its saved content (review F50; DI-04, PR-02, PR-06).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import { routes, type VersionView } from '@ebmr/api-contract';
import { flow } from '@ebmr/recipe-core/pure';
import { Banner, Button, StatusChip } from '@ebmr/ui-kit';
import { api } from '../../api/client.ts';
import { useApiQuery } from '../../api/hooks.ts';
import { useBoot } from '../../app/boot.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { dcls } from './classes.ts';
import { StateChip, shortHash } from './components/common.tsx';
import { CommandDialog, NoteField, ReadOnlyNotice } from './components/Dialogs.tsx';
import { DocumentView } from './components/DocumentView.tsx';
import { FindingsPanel, gateSummary } from './components/FindingsPanel.tsx';
import { rowId } from './components/ProcedureTable.tsx';
import { SimulationPanel } from './components/SimulationPanel.tsx';
import { StepEditor } from './components/StepEditor.tsx';
import { clearDraft, loadDraft, saveDraft, type Draft } from './model/draft.ts';
import { canRedo, canUndo, initHistory, locate, OpError, perform, redo, undo, type History, type Op } from './model/ops.ts';
import { documentNumbering } from './model/numbering.ts';
import { jumpTarget } from './model/sections.ts';
import type { FindingItem, PackageResult, PaletteItem } from './model/types.ts';
import { useDebouncedValidation } from './model/validation.ts';
import { asWire, fromWire } from './model/wire.ts';

export const auditLink = (versionId: string): string => `/audit?chain=${encodeURIComponent(`mbr_version:${versionId}`)}`;

export function DesignerPage() {
  const params: { versionId?: string } = useParams({ strict: false });
  const versionId = params.versionId ?? '';
  const version = useApiQuery(routes.designer.version, { params: { versionId } }, { enabled: versionId !== '' });
  const palette = useApiQuery(routes.designer.palette);
  // The unsaved draft (D7) is the signed-in person's own: it is stored under their id and offered to nobody else.
  const personId = useBoot().session?.person.personId ?? '';
  if (version.error) return version.error.error ? <RefusalMessage error={version.error.error} /> : <p>The version could not be loaded.</p>;
  // Without the palette the steps cannot be shown with their blocks: say so, never wait for it for good (review F55).
  if (palette.error) return palette.error.error ? <RefusalMessage error={palette.error.error} /> : <p>The step palette could not be loaded.</p>;
  if (!version.data || !palette.data) return <p>Loading the master record…</p>;
  return <DesignerEditor key={`${version.data.versionId}|${personId}`} initial={version.data} palette={palette.data.blocks} personId={personId} />;
}

/** The justify dialog keeps the warning and the saved revision (with its content hash) it was opened on. */
type JustifyDialog = { justify: FindingItem; revision: number; contentHash: string };
type Dialogs = 'save' | 'start' | 'package' | JustifyDialog | null;

export function DesignerEditor({ initial, palette, personId }: { initial: VersionView; palette: readonly PaletteItem[]; personId: string }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState<VersionView>(initial);
  const [history, setHistory] = useState<History>(() => initHistory(fromWire(initial.content)));
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [pkg, setPkg] = useState<PackageResult | null>(null);
  const [draftOffer, setDraftOffer] = useState<Draft | null>(() => loadDraft(personId, initial.versionId));
  const [restored, setRestored] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [tab, setTab] = useState<string>('findings');

  const readOnly = saved.state !== 'DRAFT';
  const present = history.present;
  const presentHash = useMemo(() => flow.mbrContentHash(present), [present]);
  const dirty = presentHash !== saved.contentHash;
  const validation = useDebouncedValidation(saved.versionId, present, generation);

  // D7: the unsaved content (only) is kept in this browser, as this person's, while it differs from the saved revision.
  useEffect(() => {
    if (readOnly || draftOffer) return;
    if (dirty) saveDraft({ personId, versionId: saved.versionId, baseRevision: saved.revision, baseHash: saved.contentHash, content: present });
    else clearDraft(personId, saved.versionId);
  }, [present, dirty, readOnly, personId, saved.versionId, saved.revision, saved.contentHash, draftOffer]);

  // Applies one operation; an OpError is shown in plain language and changes nothing.
  const apply = useCallback(
    (op: Op): boolean => {
      if (readOnly) return false;
      try {
        const next = perform(history, op);
        setHistory(next);
        setMessage(null);
        return true;
      } catch (e) {
        setMessage(e instanceof OpError ? e.message : String(e));
        return false;
      }
    },
    [history, readOnly],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || readOnly) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        setHistory(undo);
      } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
        e.preventDefault();
        setHistory(redo);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readOnly]);

  const numbering = useMemo(() => documentNumbering(present).numbering, [present]);
  const findingsByNode = useMemo(() => {
    const m = new Map<string, FindingItem[]>();
    for (const f of validation.report?.findings ?? []) if (f.nodeId) m.set(f.nodeId, [...(m.get(f.nodeId) ?? []), f]);
    return m;
  }, [validation.report]);

  const isStep = (id: string): boolean => {
    const k = locate(present, id)?.node.kind;
    return k === 'phase' || k === 'holdPoint';
  };
  const locationLabel = (f: FindingItem): string => {
    if (f.nodeId) {
      const n = numbering.byId.get(f.nodeId);
      return n ? `${n.kind === 'STAGE' ? 'stage' : n.kind === 'OPERATION' ? 'operation' : 'step'} ${n.number}` : f.nodeId;
    }
    return f.subjectPath.length > 0 ? `${f.subjectPath.join(' / ')} (section ${f.section})` : `section ${f.section}`;
  };
  const jump = (f: FindingItem): void => {
    const t = jumpTarget(f, isStep);
    if (t.stepId) {
      setSelected(t.stepId);
      setTab('step');
    }
    requestAnimationFrame(() => {
      const el = document.getElementById(t.elementId);
      el?.scrollIntoView({ block: 'center' });
      el?.focus();
    });
  };

  const afterServerChange = (v: VersionView): void => {
    setSaved(v);
    setGeneration((g) => g + 1);
    void queryClient.invalidateQueries({ queryKey: [routes.designer.families.id] });
    queryClient.setQueryData([routes.designer.version.id, { versionId: v.versionId }, {}], v);
  };

  const gatePassed = validation.report?.gate.passed === true && !validation.pending && !dirty;
  // A warning is justified only as the check of the saved revision reports it: not while that check is still
  // running, nor from a report of other content (IN-02, DI-04; review P15, P59).
  const reportIsSaved = !validation.pending && validation.report?.contentHash === saved.contentHash;
  const justifyBlocked = readOnly
    ? 'Only a DRAFT takes justifications.'
    : dirty
      ? 'Save your changes first: a justification is recorded against the saved revision.'
      : !reportIsSaved
        ? 'Wait until the saved revision has been checked: a justification answers the warning as the saved revision reports it.'
        : null;
  const justifying = typeof dialog === 'object' && dialog !== null ? dialog : null;

  return (
    <div className={dcls('page')}>
      <nav className={dcls('small')} aria-label="Breadcrumb">
        <Link to="/mbr">Master records</Link> / {saved.familyCode} / version {saved.number}
      </nav>
      <h1>
        {present.header.title} <span className={dcls('small')}>MBR-{saved.familyCode}-v{saved.number}</span>
        {/* Injectables plan I-0: the edition is data on the family; an injectables master says so (Tablets screens unchanged). */}
        {/* API edition plan A0: an API (substance) master says API. */}
        {present.header.edition !== 'tablets' ? (
          <>
            {' '}
            <StatusChip tone="neutral" label={present.header.edition === 'injectables' ? 'Injectables' : 'API'} />
          </>
        ) : null}
      </h1>

      <div className={dcls('toolbar')} role="toolbar" aria-label="Designer">
        <div className={dcls('toolbarGroup')}>
          <StateChip state={saved.state} />
          <span className={dcls('small')}>
            revision {saved.revision} · {shortHash(saved.contentHash)} · saved {saved.savedAt.text} by {saved.savedBy.legalName}
          </span>
          {dirty ? <StatusChip tone="warning" label={restored ? 'UNSAVED (restored draft)' : 'Unsaved changes'} /> : <StatusChip tone="ok" label="Saved" />}
          <StatusChip
            tone={validation.pending ? 'pending' : validation.report?.gate.passed ? 'ok' : 'error'}
            label={validation.pending ? 'Checking…' : validation.report ? gateSummary(validation.report) : 'Not checked'}
          />
        </div>
        <span className={dcls('spacer')} />
        <div className={dcls('toolbarGroup')}>
          <Button onPress={() => setHistory(undo)} isDisabled={readOnly || !canUndo(history)} aria-keyshortcuts="Control+Z">
            Undo
          </Button>
          <Button onPress={() => setHistory(redo)} isDisabled={readOnly || !canRedo(history)} aria-keyshortcuts="Control+Y">
            Redo
          </Button>
          <Button
            variant="primary"
            isDisabled={readOnly || !dirty}
            onPress={() => setDialog('save')}
          >
            Save revision…
          </Button>
          <Button isDisabled={readOnly || !gatePassed} onPress={() => setDialog('start')}>
            Start verification…
          </Button>
          <Button isDisabled={dirty || validation.report?.gate.passed !== true} onPress={() => setDialog('package')}>
            Send to sandbox…
          </Button>
          <a href={auditLink(saved.versionId)}>Audit trail</a>
          <a href={`/mbr/versions/${saved.versionId}/review`}>Change control and evidence</a>
          <a href={`/mbr/versions/${saved.versionId}/signing`}>Signatures and markets</a>
        </div>
      </div>

      {draftOffer ? (
        readOnly ? (
          // A version that is no longer a DRAFT always shows its saved content: the draft can only be discarded (F50).
          <Banner tone="warning" title="Your unsaved changes from an earlier session cannot be applied.">
            <p>
              They were based on revision {draftOffer.baseRevision}, but this version is {saved.state.replace(/_/g, ' ')}, no longer a DRAFT: what is shown is the saved revision {saved.revision}.
            </p>
            <Button
              onPress={() => {
                clearDraft(personId, saved.versionId);
                setDraftOffer(null);
              }}
            >
              Discard them
            </Button>
          </Banner>
        ) : draftOffer.baseRevision === saved.revision ? (
          <Banner tone="warning" title="Unsaved changes from an earlier session were found in this browser.">
            <p>They are based on the saved revision {draftOffer.baseRevision}. They are not saved and not part of the master until you save them as a new revision.</p>
            <div className={dcls('inline')}>
              <Button
                variant="primary"
                onPress={() => {
                  if (readOnly) return;
                  setHistory((h) => ({ past: [...h.past, h.present], present: draftOffer.content, future: [] }));
                  setRestored(true);
                  setDraftOffer(null);
                }}
              >
                Restore unsaved changes
              </Button>
              <Button
                onPress={() => {
                  clearDraft(personId, saved.versionId);
                  setDraftOffer(null);
                }}
              >
                Discard them
              </Button>
            </div>
          </Banner>
        ) : (
          <Banner tone="warning" title="An unsaved draft in this browser is out of date.">
            <p>
              It was based on revision {draftOffer.baseRevision}, but revision {saved.revision} has been saved since, so it cannot be applied.
            </p>
            <Button
              onPress={() => {
                clearDraft(personId, saved.versionId);
                setDraftOffer(null);
              }}
            >
              Discard the old draft
            </Button>
          </Banner>
        )
      ) : null}
      {readOnly ? <ReadOnlyNotice state={saved.state} /> : null}
      {message ? (
        <Banner tone="warning" title="That change was not made.">
          <p>{message}</p>
        </Banner>
      ) : null}
      {pkg ? (
        <Banner tone="ok" title="The test package is in the sandbox inbox.">
          <p>
            Package {shortHash(pkg.packageHash)} ({pkg.fileName}). Test runs in the sandbox are TEST, NOT GMP.
          </p>
          {pkg.sandboxUrl ? (
            <a href={pkg.sandboxUrl} target="_blank" rel="noopener noreferrer">
              Open the sandbox test packages
            </a>
          ) : (
            <p>The sandbox address is not configured on this installation.</p>
          )}
        </Banner>
      ) : null}

      <div className={dcls('workspace')}>
        <DocumentView
          content={present}
          version={saved}
          palette={palette}
          selected={selected}
          onSelect={(id) => {
            setSelected(id);
            setTab('step');
          }}
          dispatch={apply}
          readOnly={readOnly}
          findingsByNode={findingsByNode}
        />
        <aside className={dcls('side')} aria-label="Findings, step properties and simulation">
          <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(String(k))}>
            <TabList className={dcls('tabs')} aria-label="Panels">
              <Tab id="findings" className={dcls('tab')}>
                Findings{validation.report ? ` (${validation.report.findings.filter((f) => f.severity !== 'INFO').length})` : ''}
              </Tab>
              <Tab id="step" className={dcls('tab')}>
                Step
              </Tab>
              <Tab id="simulation" className={dcls('tab')}>
                Simulation
              </Tab>
            </TabList>
            <TabPanel id="findings">
              <FindingsPanel
                report={validation.report}
                pending={validation.pending}
                error={validation.error}
                justifyBlocked={justifyBlocked}
                onJump={jump}
                onJustify={(f) => {
                  setDialog({ justify: f, revision: saved.revision, contentHash: saved.contentHash });
                }}
                locationLabel={locationLabel}
              />
            </TabPanel>
            <TabPanel id="step">
              {selected ? (
                <StepEditor content={present} stepId={selected} number={numbering.byId.get(selected)?.number ?? '?'} palette={palette} readOnly={readOnly} dispatch={apply} />
              ) : (
                <p>Select a step in the procedure (click it, or focus it and press Enter).</p>
              )}
              {selected ? (
                <Button variant="quiet" onPress={() => document.getElementById(rowId(selected))?.focus()}>
                  Back to the step in the document
                </Button>
              ) : null}
            </TabPanel>
            <TabPanel id="simulation">
              <SimulationPanel versionId={saved.versionId} revision={saved.revision} contentHash={saved.contentHash} dirty={dirty} />
            </TabPanel>
          </Tabs>
        </aside>
      </div>

      <SaveRevisionDialog
        // A fresh note for each opening (the note lives in the dialog, so typing re-renders only the dialog).
        key={dialog === 'save' ? `save@${saved.revision}` : 'closed'}
        open={dialog === 'save'}
        versionId={saved.versionId}
        savedRevision={saved.revision}
        wireContent={() => asWire(present)}
        onClose={() => setDialog(null)}
        onDone={(v) => {
          clearDraft(personId, v.versionId);
          setRestored(false);
          afterServerChange(v);
          setDialog(null);
        }}
      />

      <JustifyWarningDialog
        // A fresh text for each opening (the text lives in the dialog, so typing re-renders only the dialog).
        key={justifying ? `${justifying.justify.key}@${justifying.revision}` : 'closed'}
        justifying={justifying}
        versionId={saved.versionId}
        savedRevision={saved.revision}
        savedHash={saved.contentHash}
        onClose={() => setDialog(null)}
        onDone={(v) => {
          afterServerChange(v);
          setDialog(null);
        }}
      />

      <CommandDialog
        title="Start verification"
        open={dialog === 'start'}
        onClose={() => setDialog(null)}
        confirmLabel="Start verification"
        run={(idempotencyKey) => api.call(routes.designer.startVerification, { params: { versionId: saved.versionId }, body: { baseRevision: saved.revision }, idempotencyKey })}
        onDone={(v) => {
          afterServerChange(v);
          setDialog(null);
        }}
      >
        <p>
          The server validates revision {saved.revision} again and records the result with its content hash. If it passes, the version moves to IN VERIFICATION and can no longer be edited.
        </p>
      </CommandDialog>

      <CommandDialog
        title="Send to a sandbox test run"
        open={dialog === 'package'}
        onClose={() => setDialog(null)}
        confirmLabel="Write the test package"
        run={(idempotencyKey) => api.call(routes.designer.testPackage, { params: { versionId: saved.versionId }, body: {}, idempotencyKey })}
        onDone={(r) => {
          setPkg(r);
          setDialog(null);
          setGeneration((g) => g + 1);
        }}
      >
        <p>
          A copy of the saved revision {saved.revision} is written, once, to the sandbox exchange inbox with its hash and the GMP origin stamp. The sandbox imports it for a test run; nothing from the sandbox ever comes back as
          a GMP record.
        </p>
      </CommandDialog>
    </div>
  );
}

/**
 * The change note of a new revision (DI-04). The note the author types is this dialog's own state: a keystroke
 * re-renders the dialog, not the whole editor behind it (the same fix as JustifyWarningDialog).
 */
function SaveRevisionDialog({ open, versionId, savedRevision, wireContent, onClose, onDone }: {
  open: boolean;
  versionId: string;
  savedRevision: number;
  wireContent: () => ReturnType<typeof asWire>;
  onClose: () => void;
  onDone: (v: VersionView) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <CommandDialog
      title={`Save revision ${savedRevision + 1}`}
      open={open}
      onClose={onClose}
      confirmLabel="Save revision"
      canConfirm={note.trim().length > 0}
      run={(idempotencyKey) =>
        api.call(routes.designer.saveContent, { params: { versionId }, body: { baseRevision: savedRevision, content: wireContent(), note: note.trim() }, idempotencyKey })
      }
      onDone={onDone}
    >
      <p>
        The new revision replaces revision {savedRevision} as the version&apos;s content. Evidence gathered on the earlier content no longer applies to it.
      </p>
      <NoteField label="Change note (what changed and why)" value={note} onChange={setNote} max={2000} />
    </CommandDialog>
  );
}

/**
 * The justification of a warning (IN-02, DI-04). The text the author types is this dialog's own state: a keystroke
 * re-renders the dialog, not the whole editor behind it.
 */
function JustifyWarningDialog({ justifying, versionId, savedRevision, savedHash, onClose, onDone }: {
  justifying: JustifyDialog | null;
  versionId: string;
  savedRevision: number;
  savedHash: string;
  onClose: () => void;
  onDone: (v: VersionView) => void;
}) {
  const [justification, setJustification] = useState('');
  return (
    <CommandDialog
      title="Justify a warning"
      open={justifying !== null}
      onClose={onClose}
      confirmLabel="Record the justification"
      canConfirm={justification.trim().length > 0 && justifying !== null}
      run={(idempotencyKey) =>
        api.call(routes.designer.justify, {
          params: { versionId },
          body: {
            findingKey: justifying?.justify.key ?? '',
            text: justification.trim(),
            // The saved revision whose warning was on screen when the dialog opened: the server refuses when it
            // was saved again since.
            baseRevision: justifying?.revision ?? savedRevision,
            contentHash: justifying?.contentHash ?? savedHash,
          },
          idempotencyKey,
        })
      }
      onDone={onDone}
    >
      {justifying ? <p>{justifying.justify.message}</p> : null}
      <p className={dcls('small')}>
        The justification is recorded with your name and the time, on the saved revision {justifying?.revision ?? savedRevision}; it travels with the version to verification and to the sandbox.
      </p>
      <NoteField label="Why the warning is acceptable" value={justification} onChange={setJustification} max={4000} />
    </CommandDialog>
  );
}
