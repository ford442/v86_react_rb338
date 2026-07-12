# Agent Directives: ReBirth RB-338 on ReactOS in v86

## Project Goal
The objective is to successfully run **ReBirth RB-338 versions 1.5 and 2.0.1** inside a **ReactOS** environment running on the **v86** x86 emulator.

## Context
ReBirth RB-338 is a software synthesizer for the TB-303, TR-808, and TR-909. It is a legacy Windows application dependent on specific audio APIs. Running it in ReactOS (an open-source Windows clone) within v86 (a JavaScript-based x86 emulator) presents specific challenges, particularly regarding audio latency and driver compatibility.

## Core Directives

1.  **Audio is Paramount**: The application is a synthesizer. If there is no sound or the sound is heavily distorted, the task is failed. You must prioritize establishing a stable audio path (driver -> ReactOS -> v86 -> Browser).
2.  **ReactOS Audio Stack**: Be aware that ReactOS's audio stack can be fragile. The user has noted potential issues with standard Windows audio drivers. You may need to investigate:
    *   Sound Blaster 16 (SB16) compatibility (the likely default in v86).
    *   AC97 compatibility (if supported/configurable).
    *   DirectSound vs. WaveOut settings within ReBirth.
3.  **Persistence**: The final result must be reproducible. This means creating a saved state or a modified disk image containing the installed software.
4.  **Resource Management**: v86 runs in the browser. Be mindful of memory allocation (RAM) in the emulated machine to ensure smooth audio performance.

## Resources
*   **ISO**: `https://1ink.us/files/rb338.iso` (Contains ReBirth 1.5 and 2.0.1 installers).
*   **ReactOS**: Use the existing ReactOS profile in v86 as a base, but be prepared to modify it or boot from a fresh installation media if the pre-built state is too restrictive.

## "Rules of Engagement"
*   **Verify Audio**: Every major step involving the OS should end with an audio check (e.g., system sounds) before proceeding to application installation.
*   **Snapshot Often**: When working in v86, save states frequently to avoid re-doing installation steps if the OS crashes (common in ReactOS).
*   **Document Driver Changes**: If you install a custom driver or modify `config.sys`/registry, document exactly what changed.
