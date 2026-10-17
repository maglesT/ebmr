/*
 * The golden batches' database clock (D-S6-6): a preload library for the golden PostgreSQL cluster that fakes the wall
 * clock from the timestamp file the golden driver writes (apps/tablets-server/test/golden/clock.ts). It replaces
 * libfaketime there (Phase 6 slice 6j-b).
 *
 * Why not libfaketime: with FAKETIME_NO_CACHE=1, libfaketime 0.9.10 reads its file with fopen/fgets inside every faked
 * time call, and fopen allocates memory. PostgreSQL calls gettimeofday inside its SIGALRM handler (handle_sig_alarm
 * computes "now" for its timeouts: the statement timeout, the deadlock check, the idle statistics flush). A signal that
 * lands while the backend is itself inside malloc then corrupts the backend's heap; glibc aborts the process (signal 6:
 * "corrupted double-linked list", a sysmalloc assertion), the postmaster resets every connection, and the server
 * answers INTERNAL. On a frozen clock a pending timeout is never due, so the handler fires again and again, and the
 * golden runs stopped at random acts. This library uses only async-signal-safe calls (open, pread, close and the raw
 * clock syscall) and no memory allocation.
 *
 * The file (FAKETIME_TIMESTAMP_FILE), as libfaketime read it:
 *   +<seconds>s          the clock runs at real speed, that many seconds ahead;
 *   YYYY-MM-DD HH:MM:SS  the clock stands still at that instant (UTC).
 * Anything else (an empty file while the driver rewrites it, say) keeps the last value read. Monotonic clocks are never
 * faked (as DONT_FAKE_MONOTONIC=1). Nothing in the GMP code reads a test clock; only the test cluster preloads this.
 *
 * Build: tools/dev-env/golden-clock/build.sh <output .so>
 */
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static char clock_file[4096];
/* The last value read: 0 = offset (seconds ahead), 1 = frozen (epoch seconds). Written whole by any caller. */
static volatile int64_t last_mode = 0;
static volatile int64_t last_value = 0;

__attribute__((constructor)) static void golden_clock_init(void) {
  const char *p = getenv("FAKETIME_TIMESTAMP_FILE");
  if (p == NULL) return;
  size_t i = 0;
  for (; p[i] != '\0' && i < sizeof clock_file - 1; i++) clock_file[i] = p[i];
  clock_file[i] = '\0';
}

static int digits(const char *s, int n, int64_t *out) {
  int64_t v = 0;
  for (int i = 0; i < n; i++) {
    if (s[i] < '0' || s[i] > '9') return 0;
    v = v * 10 + (s[i] - '0');
  }
  *out = v;
  return 1;
}

/* Days from 1970-01-01 to the civil date y-m-d (proleptic Gregorian; H. Hinnant's algorithm). */
static int64_t days_from_civil(int64_t y, int64_t m, int64_t d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const int64_t yoe = y - era * 400;
  const int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}

/* Reads the file into last_mode/last_value; keeps the last value when the file holds neither form. */
static void read_clock_file(void) {
  if (clock_file[0] == '\0') return;
  int fd = open(clock_file, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return;
  char b[64];
  ssize_t n = pread(fd, b, sizeof b - 1, 0);
  close(fd);
  if (n <= 0) return;
  while (n > 0 && (b[n - 1] == '\n' || b[n - 1] == '\r' || b[n - 1] == ' ')) n--;
  b[n] = '\0';
  int64_t v;
  if (n >= 3 && b[0] == '+' && b[n - 1] == 's' && digits(b + 1, (int)n - 2, &v)) {
    last_value = v;
    last_mode = 0;
    return;
  }
  int64_t y, mo, d, h, mi, s;
  if (n == 19 && b[4] == '-' && b[7] == '-' && b[10] == ' ' && b[13] == ':' && b[16] == ':' && digits(b, 4, &y) && digits(b + 5, 2, &mo) &&
      digits(b + 8, 2, &d) && digits(b + 11, 2, &h) && digits(b + 14, 2, &mi) && digits(b + 17, 2, &s) && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 &&
      h < 24 && mi < 60 && s < 61) {
    last_value = days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s;
    last_mode = 1;
  }
}

static int real_clock(clockid_t id, struct timespec *ts) { return (int)syscall(SYS_clock_gettime, id, ts); }

static int is_realtime(clockid_t id) { return id == CLOCK_REALTIME || id == CLOCK_REALTIME_COARSE; }

/* The faked wall clock (the real one when the library has no file). */
static int fake_now(clockid_t id, struct timespec *ts) {
  int r = real_clock(id, ts);
  if (r != 0 || clock_file[0] == '\0') return r;
  read_clock_file();
  if (last_mode == 1) {
    ts->tv_sec = (time_t)last_value;
    ts->tv_nsec = 0;
  } else {
    ts->tv_sec += (time_t)last_value;
  }
  return 0;
}

int clock_gettime(clockid_t id, struct timespec *ts) { return is_realtime(id) ? fake_now(id, ts) : real_clock(id, ts); }

int gettimeofday(struct timeval *restrict tv, void *restrict tz) {
  (void)tz;
  struct timespec ts;
  int r = fake_now(CLOCK_REALTIME, &ts);
  if (r == 0 && tv != NULL) {
    tv->tv_sec = ts.tv_sec;
    tv->tv_usec = ts.tv_nsec / 1000;
  }
  return r;
}

time_t time(time_t *t) {
  struct timespec ts;
  if (fake_now(CLOCK_REALTIME, &ts) != 0) return (time_t)-1;
  if (t != NULL) *t = ts.tv_sec;
  return ts.tv_sec;
}

int timespec_get(struct timespec *ts, int base) {
  if (base != TIME_UTC || fake_now(CLOCK_REALTIME, ts) != 0) return 0;
  return base;
}
