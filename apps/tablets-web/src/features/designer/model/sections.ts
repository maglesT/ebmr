/**
 * Sections of the document view (module C2), numbered like the server's finding locations (findings carry their
 * section 0-11), and the element ids a finding jumps to.
 */
export const DOCUMENT_SECTIONS: readonly { id: string; title: string }[] = [
  { id: '0', title: 'Title and signatures' },
  { id: '1', title: 'Product, batch sizes and header inputs' },
  { id: '2', title: 'Markets and variants' },
  { id: '3', title: 'References' },
  { id: '4', title: 'Bill of materials' },
  { id: '5', title: 'Equipment and rooms' },
  { id: '6', title: 'Parameters and limits' },
  { id: '7', title: 'Calculations' },
  { id: '8', title: 'Procedure' },
  { id: '9', title: 'Hold times and time constraints' },
  { id: '10', title: 'Yields and reconciliation' },
  { id: '11', title: 'Risk and verification' },
];

export const sectionId = (id: string): string => `mbr-section-${id}`;

export interface JumpTarget {
  /** Element id to scroll to and focus. */
  elementId: string;
  /** A procedure step to select, when the finding is about one. */
  stepId: string | null;
}

/** The content lists whose items the document shows under their own element `mbr-item-<id>` (review F44). */
const ITEM_LISTS: readonly string[] = [
  'parameters',
  'acceptanceSchemes',
  'calculations',
  'intermediates',
  'timeConstraints',
  'yieldCheckpoints',
  'riskReductions',
  'goldenCases',
  'inputs',
  'batchSizes',
  'variants',
  'references',
  'bom',
];

/**
 * Where a finding leads in the document: a procedure node (its row), a listed item (parameter, time constraint,
 * yield, ...), or its section heading.
 */
export function jumpTarget(f: { section: string; nodeId: string | null; subjectPath: readonly string[] }, isStep: (id: string) => boolean): JumpTarget {
  if (f.nodeId) return { elementId: `mbr-node-${f.nodeId}`, stepId: isStep(f.nodeId) ? f.nodeId : null };
  const item = f.subjectPath.length === 2 ? f.subjectPath[1] : undefined;
  if (item && ITEM_LISTS.includes(f.subjectPath[0] ?? '')) {
    return { elementId: `mbr-item-${item}`, stepId: null };
  }
  return { elementId: `${sectionId(f.section)}-title`, stepId: null };
}
