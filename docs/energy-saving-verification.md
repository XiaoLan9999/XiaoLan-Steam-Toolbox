# Background UI validation

The production policy now treats an unfocused window as background as well as
a minimized/hidden window. It pauses local CSS/Web Animations, media and visible
countdowns, suspends new avatar loads, coalesces UI progress events and releases
the idle screenshot conversion window after 30 seconds. The Steam.Design view
also follows the background policy. Main-process tasks, durable progress,
login keepalive and update checking are not stopped just because the GUI hides.

Native consent dialogs only cause focus loss, not view cancellation. Authorized
in-flight results survive this blur. True hiding/minimizing invalidates financial
confirmation leases and cancels their request lifetime before further dispatch.
Passwords, verification inputs and OTP displays are cleared on actual hiding;
they are not saved as part of UI restoration.

## Isolated rendering load

On 2026-11-10 an independent Electron 43.4.0 profile was run with synthetic data,
network blocking and a hidden offscreen window. Each stage lasted about 16.18s.
The production window/renderer energy-saving implementations were used, but
foreground/focus/hidden states were logical models because the window never
appeared on the user's desktop.

| Stage | Sum of Electron AppMetrics CPU means | UI update/rAF callbacks | Main task ticks |
|---|---:|---:|---:|
| Foreground model | 1.2406 | 162 / 485 | 148 |
| Unfocused saving | 0.0352 | 0 / 0 | 149 |
| Hidden/tray model | 0.0217 | 0 / 0 | 148 |

All 40 test animations paused and their timelines stopped. Renderer heartbeat
callbacks continued. Network requests attempted: zero. A separate native smoke
test created a real tray handle/menu, retained a hidden fixture window, then
destroyed both and exited without accessing Steam or user data.

These CPU numbers follow Electron's metrics, not necessarily Task Manager's CPU
normalization. Offscreen paint events have pixel-copy/NativeImage overhead, so
the baseline includes test-framework costs. Summed working sets double-count
shared memory and depend on the order of cache reclamation; no actual-RAM-saved
claim is made from that difference. This is not a real-game FPS, GPU utilization,
battery-power or comparative Watt Toolkit benchmark.

Confirmed behavior is that dynamic UI work stops while background work remains
alive. A real user's workload still needs observation; background work itself
can consume resources. The main renderer is not force-killed and unsaved drafts
are not discarded merely to make a memory number look smaller.
