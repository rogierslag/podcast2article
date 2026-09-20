/** A read is an engagement estimate, never the owner's explicit read status. */
export function createShareTracker({ send, now = () => performance.now() }) {
  let loaded = false;
  let read = false;
  let sending = false;
  let previousTick = now();
  let lastActivity = previousTick;
  let activeMs = 0;
  let visibleMs = 0;
  let wasVisible = false;

  return {
    activity() {
      lastActivity = now();
    },
    async tick({ visible, progress }) {
      const current = now();
      const elapsed = current - previousTick;
      previousTick = current;
      // A brief preview must not count as an open.
      // Require consecutive visible time.
      if (visible && wasVisible && elapsed >= 0 && elapsed <= 2_000) {
        visibleMs += elapsed;
      } else {
        visibleMs = 0;
      }
      // Ignore suspended timers and time spent away from the reader.
      if (
        visible &&
        wasVisible &&
        current - lastActivity <= 60_000 &&
        elapsed <= 2_000
      ) {
        activeMs += Math.max(0, elapsed);
      }
      wasVisible = visible;
      if (!visible || sending || read) {
        return;
      }
      if (!loaded && visibleMs < 2_000) {
        return;
      }
      const event = !loaded
        ? "load"
        : activeMs >= 30_000 && progress >= 90
          ? "read"
          : undefined;
      if (!event) {
        return;
      }
      sending = true;
      try {
        if (await send(event)) {
          loaded = true;
          if (event === "read") {
            read = true;
          }
        }
      } catch {
        // Monitoring must never interrupt reading.
        // A later tick retries.
      } finally {
        sending = false;
      }
    },
  };
}
