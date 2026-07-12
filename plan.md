# Plan: ReBirth RB-338 on ReactOS via v86

This plan covers installing ReBirth RB-338 (1.5 and 2.0.1) on ReactOS in v86, and closing [copy/v86#1007](https://github.com/copy/v86/issues/1007) (sound in ReactOS).

> **Note:** ReactOS issue [#1007](https://github.com/ReactOS/reactos/issues/1007) is unrelated (OSK welcome dialog, closed in 2018). The audio work tracks **v86 issue #1007**.

## Do you need to build a ReactOS image?

**No, not to start.** v86 already ships hosted ReactOS disk images:

| Profile | Disk | Saved state | Use for |
|---------|------|-------------|---------|
| `reactos` | `reactos-v3/.img` | yes (`reactos_state-v3.bin.zst`) | Quick desktop demo |
| `reactos-boot` | `reactos-v2/.img` | no | Fresh boot, driver install, ReBirth setup |

You **do** need:

1. **ReBirth ISO** — e.g. `rb338.iso` from [archive.org/details/rebirthrb338](https://archive.org/details/rebirthrb338) or your mirror. Place it under `images/` for local serving.
2. **AC'97 audio enabled** — use `?ac97=1` or the debug UI checkbox (see below). The default SB16 ISA device has no working ReactOS driver in v86.
3. **Persistence after install** — either a v86 **save state** (easiest) or a modified HDA image with ReBirth installed.

The pre-built `reactos` saved state was captured with SB16 hardware. For AC'97 testing, prefer **`reactos-boot`** without that state file, or boot `reactos` with `?ac97=1` and reinstall the audio driver in Device Manager.

## Phase 1: v86 + AC'97 (closes v86 #1007)

The `ac97` branch adds an Intel 82801AA (8086:2415) PCI AC'97 controller. ReactOS already ships an in-tree driver for Intel AC'97 controllers ([reactos/reactos#4366](https://github.com/reactos/reactos/pull/4366)).

1. Build v86: `make` (debug) or `make all` (release).
2. Serve locally: `make run` → open `http://localhost:8000/debug.html`.
3. Start **ReactOS (boot)** with **Use AC'97 instead of SB16** checked, or use:
   ```
   debug.html?profile=reactos-boot&ac97=1&acpi=1
   ```
4. In ReactOS: Device Manager should show **Intel 82801AA AC'97 Audio Controller**. If not, use the in-tree AC97 driver from RAPPS or add hardware manually.
5. Verify audio: Control Panel → Sounds → play a system sound.
6. If sound works in the browser, v86 #1007 is addressed on the emulator side. Any remaining glitches are likely ReactOS audio stack issues (DirectSound/WaveOut), not missing hardware.

### ford442/reactos fork

Your [ford442/reactos](https://github.com/ford442/reactos) fork is not required for the v86-side fix — mainline ReactOS already has the Intel AC'97 INF changes. Keep that fork for any ReactOS-kernel or driver bugs you discover while testing ReBirth.

## Phase 2: Mount ReBirth ISO

In `debug.html`:

1. Choose **ReactOS (boot)** (or `reactos` after audio works).
2. Enable AC'97.
3. Under **CD-ROM**, select `images/rb338.iso` (or your local copy).
4. Boot order: CD first if you need to run setup from disc.

Or embed in code / URL once the ISO is hosted alongside the emulator.

## Phase 3: Install ReBirth

1. Open the CD drive in ReactOS Explorer.
2. Run the **1.5** installer (`SETUP.EXE`), then the **2.0.1** update/full installer from the same ISO.
3. ReBirth may ask for the CD — keep the ISO mounted as the virtual CD-ROM.
4. On modern Windows, ReBirth needs a patched `winhlp32.exe`; ReactOS may or may not need the same for Help. The synth itself can run without Help.

## Phase 4: Audio tuning in ReBirth

1. Launch ReBirth 2.0.1 → Edit → Preferences → Audio System.
2. Try **DirectSound** first, then **WaveOut (MME)** if DirectSound fails.
3. Increase buffer/latency (≥100 ms) — v86 + browser audio needs higher buffers than native Windows.

## Phase 5: Persistence

**Option A — Save state (recommended)**

1. With ReBirth installed and audio working, use v86's save-state feature.
2. Store as e.g. `reactos_rebirth_ac97.bin.zst`.
3. Load via `initial_state` in a custom profile.

**Option B — Custom disk image**

1. Use `reactos-boot` HDA, install everything, shut down cleanly.
2. Export the `.img` from v86's disk buffer or copy from `images/` if you built locally.
3. Host the image and point a profile's `hda.url` at it.

## Branch status in this repo

| Branch | Contents |
|--------|----------|
| `ac97` | Intel AC'97 device emulation (`src/ac97.js`) |
| `react` | This plan + `AGENT.md` |
| `cursor/merge-ac97-rebirth-cd4f` | AC'97 + plan + state-index fix + ReactOS profile defaults |

## Success criteria

- [ ] ReactOS detects Intel AC'97 and plays system sounds with `ac97=1`
- [ ] ReBirth 1.5 / 2.0.1 installs from ISO
- [ ] ReBirth produces audible output (WaveOut or DirectSound)
- [ ] Setup is reproducible via save state or custom image
