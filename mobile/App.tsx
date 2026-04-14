/**
 * Vox - Privacy-preserving medical dictation.
 *
 * MVP first screen: model download (if needed), then a record button +
 * live transcript view. Everything stays on-device.
 *
 * Design tokens come from /Users/jk/temp/vox/DESIGN.md.
 */

import React, { useEffect, useState, useRef } from "react";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  StatusBar,
  Platform,
  PermissionsAndroid,
} from "react-native";
import {
  ensureFrenchModel,
  initSherpaEngine,
  isSherpaReady,
  SherpaDownloadProgress,
} from "./src/stt/sherpa-streaming";
import {
  downloadOfflineModel,
  isWhisperReady,
  initOfflineEngine,
} from "./src/stt/whisper-offline";
import {
  startHybridTranscription,
  HybridHandle,
  HybridUpdate,
} from "./src/stt/hybrid-engine";
import { applyCorrections } from "./src/pipeline/correct";

// Design tokens (from DESIGN.md)
const COLORS = {
  primary: "#0a7e8c",
  recording: "#ff3b30",
  success: "#34c759",
  text: "#1a1a1a",
  secondary: "#636366",
  muted: "#8e8e93",
  bg: "#fafafa",
  surface: "#ffffff",
  border: "#e5e5e5",
  correction: "#fff3cd",
};

type AppState =
  | "checking"
  | "needsDownload"
  | "downloading"
  | "loadingModel"
  | "ready"
  | "recording"
  | "transcribing";

export default function App() {
  const [state, setState] = useState<AppState>("checking");
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadPhase, setDownloadPhase] = useState("");
  const [transcript, setTranscript] = useState("");
  const [offlineReady, setOfflineReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hybridRef = useRef<HybridHandle | null>(null);

  // Initial: download model if needed, init engine, request mic permission
  useEffect(() => {
    (async () => {
      try {
        // Request mic permission early on Android
        if (Platform.OS === "android") {
          await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
            {
              title: "Microphone",
              message: "Vox a besoin du microphone pour la dictee.",
              buttonPositive: "OK",
            }
          );
        }
        await handleDownloadAndInit();
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    })();
  }, []);

  async function handleDownloadAndInit() {
    setState("downloading");
    setError(null);
    try {
      // 1. Download + init the streaming zipformer (351MB, for real-time)
      setDownloadPhase("Modèle streaming");
      const modelPath = await ensureFrenchModel((p: SherpaDownloadProgress) => {
        setDownloadPercent(p.percent * 0.5); // first half of progress
        setDownloadPhase("Modèle streaming");
      });

      setState("loadingModel");
      await initSherpaEngine(modelPath);

      // 2. Download the whisper distil-fr model (513MB, for offline accuracy)
      // Do this in the background so the user can start dictating immediately
      setState("ready");
      downloadOfflineInBackground();
    } catch (e: any) {
      setError(`Initialisation: ${e?.message ?? e}`);
      setState("needsDownload");
    }
  }

  async function downloadOfflineInBackground() {
    try {
      console.log("[vox] Downloading Canary-180M-Flash in background...");
      await initOfflineEngine();
      setOfflineReady(true);
      console.log("[vox] Canary-180M-Flash offline engine ready");
    } catch (e: any) {
      // Non-fatal: streaming still works without offline pass
      console.warn(`[vox] Offline engine init failed (non-fatal): ${e?.message ?? e}`);
    }
  }

  async function handleStartRecording() {
    if (!isSherpaReady()) {
      setError("Modèle non chargé");
      return;
    }
    try {
      const handle = await startHybridTranscription(
        (update: HybridUpdate) => {
          setTranscript(update.text);
        },
        (errMsg) => {
          setError(`Transcription: ${errMsg}`);
          setState("ready");
          hybridRef.current = null;
        }
      );
      hybridRef.current = handle;
      setState("recording");
    } catch (e: any) {
      setError(`Enregistrement: ${e?.message ?? e}`);
      setState("ready");
    }
  }

  async function handleStopRecording() {
    const handle = hybridRef.current;
    if (!handle) return;
    try {
      setState("transcribing");
      await handle.stop();
      hybridRef.current = null;
      setState("ready");
    } catch (e: any) {
      setError(`Arret: ${e?.message ?? e}`);
      setState("ready");
      hybridRef.current = null;
    }
  }

  // ----- Render helpers -----

  function renderDownload() {
    const downloadingNow = state === "downloading";

    return (
      <View style={styles.centerContainer}>
        <Text style={styles.brandTitle}>Vox</Text>
        <Text style={styles.brandSubtitle}>Dictée médicale privée</Text>

        <View style={{ height: 48 }} />

        <Text style={styles.downloadHeader}>
          {downloadingNow ? "Installation du modèle vocal" : "Modèle vocal requis"}
        </Text>
        <Text style={styles.downloadSize}>~350 Mo + 147 Mo (modèle de précision)</Text>

        <View style={{ height: 24 }} />

        <Text style={styles.privacyMessage}>
          Ce modèle d'intelligence artificielle reste sur votre appareil.
          Vos dictées ne quitteront jamais votre téléphone.
        </Text>

        <View style={{ height: 32 }} />

        {downloadingNow ? (
          <View style={{ alignItems: "center" }}>
            <View style={styles.progressBar}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.min(100, Math.round(downloadPercent))}%` },
                ]}
              />
            </View>
            <Text style={styles.progressText}>
              {downloadPhase || "Téléchargement"} {Math.min(100, Math.round(downloadPercent))}%
            </Text>
          </View>
        ) : (
          <View style={{ alignItems: "center" }}>
            <TouchableOpacity style={styles.primaryButton} onPress={handleDownloadAndInit}>
              <Text style={styles.primaryButtonText}>Télécharger</Text>
            </TouchableOpacity>
            {error && <Text style={styles.inlineError}>{error}</Text>}
          </View>
        )}
      </View>
    );
  }

  function renderLoading(label: string) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.brandTitle}>Vox</Text>
        <Text style={styles.loadingLabel}>{label}</Text>
      </View>
    );
  }

  function renderDictation() {
    const isRecording = state === "recording";
    const isBusy = state === "transcribing";

    return (
      <View style={styles.dictationContainer}>
        <View style={styles.topBar}>
          <Text style={styles.appTitle}>Vox</Text>
          <View style={styles.statusRight}>
            <View style={[styles.dot, { backgroundColor: offlineReady ? COLORS.success : COLORS.muted }]} />
            <Text style={styles.statusLabel}>{offlineReady ? "HD" : "Chargement..."}</Text>
          </View>
        </View>

        <ScrollView
          style={styles.transcriptArea}
          contentContainerStyle={styles.transcriptContent}
        >
          {transcript ? (
            <Text style={styles.transcriptText}>{transcript}</Text>
          ) : (
            <Text style={styles.placeholder}>
              Appuyez sur le bouton pour commencer la dictée.
            </Text>
          )}
          {state === "recording" && (
            <Text style={styles.latency}>
              Écoute en cours...
            </Text>
          )}
        </ScrollView>

        <View style={styles.controls}>
          <TouchableOpacity
            style={[
              styles.recordButton,
              isRecording && styles.recordButtonRecording,
              isBusy && styles.recordButtonDisabled,
            ]}
            onPress={isRecording ? handleStopRecording : handleStartRecording}
            disabled={isBusy}
          >
            <View
              style={[
                styles.recordButtonInner,
                isRecording && styles.recordButtonInnerRecording,
              ]}
            />
          </TouchableOpacity>
          <Text style={styles.controlLabel}>
            {isBusy
              ? "Transcription..."
              : isRecording
              ? "Toucher pour arrêter"
              : "Toucher pour dicter"}
          </Text>
        </View>
      </View>
    );
  }

  // ----- Main render -----

  let content: React.ReactNode;
  // For download errors we keep the user on the download screen so they
  // can resume; only show the full-screen error for other failures.
  const isDownloadError = error && state === "needsDownload";

  if (error && !isDownloadError) {
    content = (
      <View style={styles.centerContainer}>
        <Text style={styles.errorTitle}>Erreur</Text>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => {
            setError(null);
            setState("checking");
          }}
        >
          <Text style={styles.primaryButtonText}>Réessayer</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (state === "checking") {
    content = renderLoading("Initialisation...");
  } else if (state === "needsDownload" || state === "downloading") {
    content = renderDownload();
  } else if (state === "loadingModel") {
    content = renderLoading("Chargement du modele...");
  } else {
    content = renderDictation();
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" />
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
    paddingTop: Platform.OS === "ios" ? 54 : 24,
  },
  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  brandTitle: {
    fontSize: 32,
    fontWeight: "700",
    color: COLORS.text,
    letterSpacing: -0.5,
  },
  brandSubtitle: {
    fontSize: 14,
    color: COLORS.muted,
    marginTop: 8,
  },
  downloadHeader: {
    fontSize: 16,
    color: COLORS.text,
    fontWeight: "600",
  },
  downloadSize: {
    fontSize: 13,
    color: COLORS.muted,
    marginTop: 4,
  },
  privacyMessage: {
    fontSize: 14,
    color: COLORS.secondary,
    textAlign: "center",
    lineHeight: 22,
  },
  privacyHint: {
    fontSize: 12,
    color: COLORS.muted,
    textAlign: "center",
    fontStyle: "italic",
  },
  resumeNote: {
    fontSize: 13,
    color: COLORS.secondary,
    textAlign: "center",
    marginBottom: 16,
    paddingHorizontal: 16,
  },
  secondaryAction: {
    fontSize: 13,
    color: COLORS.muted,
    textDecorationLine: "underline",
  },
  inlineError: {
    fontSize: 12,
    color: COLORS.recording,
    textAlign: "center",
    marginTop: 16,
    paddingHorizontal: 16,
  },
  progressBar: {
    width: 240,
    height: 6,
    backgroundColor: COLORS.border,
    borderRadius: 3,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: COLORS.primary,
  },
  progressText: {
    fontSize: 13,
    color: COLORS.muted,
    marginTop: 12,
    fontVariant: ["tabular-nums"],
  },
  primaryButton: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 6,
  },
  primaryButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  loadingLabel: {
    fontSize: 14,
    color: COLORS.muted,
    marginTop: 16,
  },
  dictationContainer: {
    flex: 1,
  },
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  appTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: COLORS.text,
    letterSpacing: -0.3,
  },
  statusRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusLabel: {
    fontSize: 11,
    color: COLORS.muted,
  },
  transcriptArea: {
    flex: 1,
  },
  transcriptContent: {
    padding: 20,
    paddingBottom: 32,
  },
  transcriptText: {
    fontSize: 16,
    lineHeight: 26,
    color: COLORS.text,
  },
  placeholder: {
    fontSize: 15,
    color: COLORS.muted,
    fontStyle: "italic",
  },
  latency: {
    fontSize: 11,
    color: COLORS.muted,
    marginTop: 16,
    fontVariant: ["tabular-nums"],
  },
  controls: {
    paddingBottom: 48,
    paddingTop: 16,
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  recordButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: COLORS.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  recordButtonRecording: {
    backgroundColor: COLORS.recording,
  },
  recordButtonDisabled: {
    opacity: 0.5,
  },
  // Idle: solid circle (the universal "record" symbol).
  recordButtonInner: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#fff",
  },
  // Recording: solid square (the universal "stop" symbol).
  recordButtonInnerRecording: {
    width: 24,
    height: 24,
    borderRadius: 4,
  },
  controlLabel: {
    fontSize: 13,
    color: COLORS.muted,
    marginTop: 12,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: COLORS.recording,
    marginBottom: 12,
  },
  errorText: {
    fontSize: 14,
    color: COLORS.text,
    textAlign: "center",
    marginBottom: 24,
  },
});
