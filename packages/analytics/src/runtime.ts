/**
 * What a run records about the code that computed it (ADR 0020 points 4 and 7; interfaces section 2, analytics.run
 * runtime): this package's version and the exact versions of the numerical libraries it uses. The runner adds the
 * commit and the Node version. A test keeps these equal to package.json, so a library change is a visible change of
 * every later run's runtime (and, under DI-52, a new method version where it changes results).
 */

/** The package version (package.json "version"). */
export const ANALYTICS_PACKAGE_VERSION = '0.1.0';

/** The libraries of package.json "dependencies", at their exact pinned versions (D-6A-23). */
export const RUNTIME_LIBRARIES: Readonly<Record<string, string>> = {
  '@stdlib/stats-base-dists-beta-quantile': '0.2.3',
  '@stdlib/stats-base-dists-chisquare-quantile': '0.2.3',
  '@stdlib/stats-base-dists-f-quantile': '0.2.3',
  '@stdlib/stats-base-dists-normal-quantile': '0.3.1',
  '@stdlib/stats-base-dists-t-quantile': '0.2.3',
  'ml-matrix': '6.15.0',
};
