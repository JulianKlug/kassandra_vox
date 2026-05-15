# Deploying Vox to an Android phone over USB

This is the phone-side of Vox: an Expo + React Native dev-client build with three native modules (`whisper.rn`, `react-native-sherpa-onnx`, `@fugood/react-native-audio-pcm-stream`). Expo Go can't run it — every install requires a real native build.

Below is the minimum recipe to get a debug build onto a USB-C Android phone for development. iOS deployment is similar but uses Xcode + a paid Apple Developer account — not covered here.

## Prerequisites (one-time)

On the **host** (your laptop):

- **Node 20+** and `npm`
- **JDK 17** — `brew install --cask zulu@17` on macOS. Set `JAVA_HOME`:
  ```sh
  export JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home
  ```
- **Android Studio** with the SDK + platform-tools. `adb` should live at `~/Library/Android/sdk/platform-tools/adb`. Add to your `PATH`:
  ```sh
  export ANDROID_HOME=$HOME/Library/Android/sdk
  export PATH=$PATH:$ANDROID_HOME/platform-tools
  ```
- Install JS deps once:
  ```sh
  cd mobile && npm install
  ```

On the **phone** (one-time):

1. **Enable Developer Mode** — Settings → About phone → tap **Build number** 7 times.
2. **Enable USB Debugging** — Settings → System → Developer options → **USB debugging** ON.
3. **Connect via USB-C.** The first time, the phone shows an "Allow USB debugging?" prompt with the host's RSA fingerprint. Tap **Always allow** and **OK**.

## Verify the phone is visible

```sh
adb devices
```

You should see one line ending in `device`:

```
List of devices attached
RFCT12345ABC    device
```

If it says `unauthorized`, re-confirm the prompt on the phone. If the phone is missing entirely:

- Try a different cable — many USB-C cables are charge-only with no data lines.
- On the phone, swipe down the USB notification → change USB mode to **File transfer (MTP)** (some devices need this before debug shows up).
- `adb kill-server && adb start-server` and retry.

## Build + install

From the `mobile/` directory:

```sh
npx expo run:android --device
```

The `--device` flag forces deployment to the connected phone (otherwise Expo may pick an emulator if one is running). If you have multiple devices, pass `-s <id>`:

```sh
npx expo run:android --device --device <id>
```

First build is slow (5–10 min on cold cache) — Gradle compiles native modules. Subsequent builds are 10–30s.

When it finishes you'll see `BUILD SUCCESSFUL`, `Installing app-debug.apk`, and then the dev-client deep link. The Metro bundler keeps running in the terminal; **leave that terminal open**.

## Microphone permission

On first launch the app asks for `RECORD_AUDIO`. Grant it. If you accidentally deny:

```sh
adb shell pm grant com.vox.dictation android.permission.RECORD_AUDIO
```

## Metro reachability over USB

Dev builds need to load the JS bundle from Metro running on your laptop. The dev client auto-discovers Metro at `http://10.0.2.2:8081` (emulator alias) or your LAN IP; on a USB-connected phone the LAN path is fragile (different Wi-Fi networks, VPNs, hostile corporate routers). Forward port 8081 over the USB cable instead:

```sh
adb reverse tcp:8081 tcp:8081
```

This makes `localhost:8081` on the phone resolve to your laptop. Re-run after every reconnect / reboot.

If the app shows "Could not connect to development server", run the command above and shake the phone (or `adb shell input keyevent 82`) → **Reload**.

## Standalone (no Metro) — for clinical use

For real dictation away from the laptop, build a release APK that bundles the JS:

```sh
cd android
./gradlew assembleRelease
```

The APK lands at `android/app/build/outputs/apk/release/app-release.apk`. Install it:

```sh
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

This APK runs without Metro and doesn't need the USB cable after install. Signing config lives in `android/app/build.gradle` — the default debug keystore is fine for local use; for distribution you'd configure a proper signing key.

## Useful adb commands

| What | Command |
|---|---|
| Tail JS console | `adb logcat -s ReactNativeJS:V` |
| Tail Vox logs only | `adb logcat -s ReactNativeJS:V \| grep -E "\[vox\]\|\[Vox"` |
| Force-stop the app | `adb shell am force-stop com.vox.dictation` |
| Launch the app | `adb shell am start -n com.vox.dictation/.MainActivity` |
| Uninstall | `adb uninstall com.vox.dictation` |
| Open dev menu | `adb shell input keyevent 82` |
| Reverse-port Metro | `adb reverse tcp:8081 tcp:8081` |

## Test mode (run the on-device test harness)

Stage spike data and trigger the in-app test harness:

```sh
./scripts/run-device-tests.sh
```

The harness runs integration tests, the WER benchmark, and the progressive-passes sweep. Output streams to your terminal. See `scripts/run-device-tests.sh` and `scripts/push-test-data.sh` for the moving parts.

## Common gotchas

- **"adb: command not found"** — `PATH` doesn't include `platform-tools`. Re-export `ANDROID_HOME` and `PATH` in your shell rc.
- **"INSTALL_FAILED_UPDATE_INCOMPATIBLE"** — a debug APK was installed by another machine with a different signing key. `adb uninstall com.vox.dictation` first.
- **"Unable to load script… make sure you're either running Metro or that your bundle 'index.android.bundle' is packaged correctly for release"** — Metro isn't reachable. Run `adb reverse tcp:8081 tcp:8081` or rebuild release.
- **App installs but instantly closes** — check `adb logcat -s AndroidRuntime:E` for the crash. Most often a missing native asset (whisper model not present in app's documents dir on first run — open the app, let it download, then retry).
- **Microphone records silence** — some Pixel phones require granting permission via Settings → Apps → Vox → Permissions explicitly; the in-app dialog isn't always sufficient.
