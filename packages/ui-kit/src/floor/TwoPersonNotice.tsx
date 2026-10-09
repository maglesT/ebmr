/** TwoPersonNotice (module C4): the manual weighing path is clearly marked: a second person must verify (G-07, G-22). */
import { Banner } from '../primitives/Banner.tsx';
import { ft } from './messages.ts';

export function TwoPersonNotice() {
  return (
    <Banner tone="warning" title={ft('twoPerson.title')}>
      <p>{ft('twoPerson.body')}</p>
    </Banner>
  );
}
