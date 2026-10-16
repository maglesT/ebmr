/**
 * The acknowledgment of a plant alarm (DI-49): the action taken always, a comment for a GMP-critical alarm, a deviation
 * reference where the alarm's configuration requires one. The button stays disabled until those are given; the database
 * checks them again and its refusal is shown in its own words. FRESH_ON_SHARED: a fresh badge tap on a shared terminal.
 */
import { useState } from 'react';
import { routes, type PlantAlarmView } from '@ebmr/api-contract';
import { Button, Dialog, Field } from '@ebmr/ui-kit';
import { ActButton, ActResult, useCommand } from '../../app/acts.tsx';
import { ALARM_READS } from './reads.ts';

type AckSubject = Pick<PlantAlarmView, 'alarmId' | 'alarmCode' | 'message' | 'gmpCritical' | 'deviationRequired'>;

export function AcknowledgeAlarm({ alarm }: { alarm: AckSubject }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onPress={() => setOpen(true)}>Acknowledge</Button>
      {open ? <AckDialog alarm={alarm} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AckDialog({ alarm: a, onClose }: { alarm: AckSubject; onClose: () => void }) {
  const ack = useCommand(routes.alarms.acknowledge, ALARM_READS, 'the acknowledgment of the alarm');
  const [action, setAction] = useState('');
  const [comment, setComment] = useState('');
  const [deviationRef, setDeviationRef] = useState('');
  const ok = action.trim() !== '' && (!a.gmpCritical || comment.trim() !== '') && (!a.deviationRequired || deviationRef.trim() !== '');
  return (
    <Dialog title={`Acknowledge ${a.alarmCode}`} isOpen onOpenChange={(o) => (o ? undefined : onClose())}>
      <div data-testid={`ack-dialog-${a.alarmId}`}>
        <p>{a.message}</p>
        <Field name="ackAction" label="Action taken" value={action} onChange={setAction} isRequired />
        <Field
          name="ackComment"
          label={a.gmpCritical ? 'Comment (required: GMP-critical alarm)' : 'Comment (optional)'}
          value={comment}
          onChange={setComment}
          isRequired={a.gmpCritical}
        />
        <Field
          name="ackDeviation"
          label={a.deviationRequired ? 'Deviation reference (required for this alarm)' : 'Deviation reference (optional)'}
          value={deviationRef}
          onChange={setDeviationRef}
          isRequired={a.deviationRequired}
        />
        <ActButton
          label="Acknowledge the alarm"
          disabled={!ok || ack.busy}
          onPress={async () => {
            if (!ok) return;
            const r = await ack.run({
              params: { alarmId: a.alarmId },
              body: {
                actionTaken: action.trim(),
                ...(comment.trim() !== '' ? { comment: comment.trim() } : {}),
                ...(deviationRef.trim() !== '' ? { deviationRef: deviationRef.trim() } : {}),
              },
            });
            if (r) onClose();
          }}
        />
        <Button onPress={onClose} isDisabled={ack.busy}>
          Cancel
        </Button>
        <ActResult error={ack.error} done={null} />
      </div>
    </Dialog>
  );
}
