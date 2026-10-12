/** Shared parts of the review screens. */

/** A gate of a signed act: nothing when ready, else the database's reasons why not, in its words. */
export function GateProblems({ gate, testId }: { gate: { ready: boolean; problems: string[] }; testId: string }) {
  if (gate.ready) return null;
  return (
    <div data-testid={testId}>
      <p>Not yet possible:</p>
      <ul>
        {gate.problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}
