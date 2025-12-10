# Plan: ReBirth RB-338 on ReactOS via v86

This plan details the steps to install and configure ReBirth RB-338 (1.5 & 2.0.1) on ReactOS running in v86.

## Phase 1: Environment Setup

1.  **Local v86 Setup**
    *   Ensure the v86 project is built and running locally (`npm install`, `npm start` or equivalent).
    *   Verify the standard ReactOS profile boots successfully.

2.  **Acquire Assets**
    *   Download the ReBirth ISO: `https://1ink.us/files/rb338.iso`.
    *   Place the ISO in the `images/` directory (or wherever local assets are served from) so it can be mounted by v86.

## Phase 2: VM Configuration & Boot

3.  **Boot Configuration**
    *   Modify the ReactOS profile (or create a custom URL/config) to mount `rb338.iso` as the CD-ROM drive (`cdrom` parameter).
    *   Ensure `disable_audio` is `false` (or unchecked).
    *   **Crucial**: Verify the emulated sound card. v86 typically emulates a Sound Blaster 16 (SB16). ReactOS should detect this.

4.  **Initial Boot & Audio Check**
    *   Boot ReactOS.
    *   **Verify Audio**: Go to Control Panel > Sounds and Multimedia. Check if a default audio device is detected. Try to play a system sound.
    *   *Decision Point*: If no audio device is found, we must install the SB16 driver for ReactOS or debug the v86 hardware definition.

## Phase 3: Installation

5.  **Install ReBirth 1.5**
    *   Navigate to the CD-ROM drive in ReactOS Explorer.
    *   Locate the ReBirth 1.5 installer.
    *   Run `SETUP.EXE`. Follow on-screen instructions.
    *   *Note*: If the installer hangs, try running in Windows 95 compatibility mode (if available in ReactOS properties) or simply retry.

6.  **Install ReBirth 2.0.1 (Update/Full)**
    *   Locate the 2.0.1 installer/update on the ISO.
    *   Run and install.

## Phase 4: Audio Tuning & Troubleshooting (The "Hard Part")

7.  **First Run**
    *   Launch ReBirth 2.0.1.
    *   **Check Preferences**: Go to Edit > Preferences > Audio System.
    *   **Driver Selection**: ReBirth usually offers "DirectSound" and "WaveOut" (MME).
        *   Try *DirectSound* first (lower latency usually, but might be buggy in ReactOS).
        *   If that fails or crackles, switch to *WaveOut*.
    *   **Buffer Size/Latency**: Increase the buffer size in ReBirth settings if the audio stutters. v86 is software emulation; low latency settings (e.g., <50ms) will likely cause dropouts.

8.  **Driver Customization (If Standard Fails)**
    *   If the default ReactOS SB16 driver is unstable:
        *   Locate a Windows NT4/2000 compatible SB16 driver (since ReactOS is NT-based).
        *   Mount a floppy image or ISO with these drivers.
        *   Manually update the driver via Device Manager.

## Phase 5: Persistence & Verification

9.  **Save State**
    *   Once ReBirth is running and making sound:
    *   Use the v86 "Save State" feature to generate a `.bin` state file.
    *   Rename this to `reactos_rebirth.bin` for easy loading.

10. **Final Verification**
    *   Reload the page/emulator using the saved state.
    *   Ensure ReBirth is open and audio plays immediately without reconfiguration.

## Phase 6: Delivery

11. **Documentation**
    *   Update documentation with the specific settings (Audio Driver choice, Buffer Size) that worked.
