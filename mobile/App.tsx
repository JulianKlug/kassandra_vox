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
  Alert,
} from "react-native";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import {
  isModelDownloaded,
  downloadModel,
  ensureModelsDir,
  getModelInfo,
  ModelVariant,
  DownloadProgress,
} from "./src/whisper/model";
import {
  loadModel,
  transcribeFile,
  isModelLoaded,
} from "./src/whisper/transcriber";
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

const MODEL_VARIANT: ModelVariant = "large-v3";

export default function App() {
  const [state, setState] = useState<AppState>("checking");
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);

  // Initial: check whether model exists, request mic permission
  useEffect(() => {
    (async () => {
      try {
        await ensureModelsDir();
        const has = await isModelDownloaded(MODEL_VARIANT);
        if (!has) {
          setState("needsDownload");
        } else {
          await loadAndReady();
        }
        // Request mic permission early
        await Audio.requestPermissionsAsync();
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    })();
  }, []);

  async function loadAndReady() {
    setState("loadingModel");
    try {
      await loadModel(MODEL_VARIANT);
      setState("ready");
    } catch (e: any) {
      setError(`Model load failed: ${e?.message ?? e}`);
    }
  }

  async function handleDownload() {
    setState("downloading");
    setError(null);
    try {
      await downloadModel(MODEL_VARIANT, (p: DownloadProgress) => {
        setDownloadPercent(p.percent);
      });
      await loadAndReady();
    } catch (e: any) {
      setError(`Download failed: ${e?.message ?? e}`);
      setState("needsDownload");
    }
  }

  async function handleStartRecording() {
    if (!isModelLoaded()) {
      setError("Model not loaded");
      return;
    }
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Microphone", "Permission requise pour la dictee.");
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      recordingRef.current = recording;
      setState("recording");
    } catch (e: any) {
      setError(`Recording failed: ${e?.message ?? e}`);
    }
  }

  async function handleStopRecording() {
    const rec = recordingRef.current;
    if (!rec) return;
    try {
      setState("transcribing");
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      recordingRef.current = null;
      if (!uri) {
        setError("No audio recorded");
        setState("ready");
        return;
      }

      // Transcribe
      const result = await transcribeFile(uri);

      // Apply post-processor (medical corrections)
      const corrected = applyCorrections(result.text);

      setTranscript((prev) => (prev ? prev + " " : "") + corrected.text.trim());
      setLatencyMs(result.durationMs);
      setState("ready");

      // Cleanup audio file
      try {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      } catch {}
    } catch (e: any) {
      setError(`Transcription failed: ${e?.message ?? e}`);
      setState("ready");
    }
  }

  // ----- Render helpers -----

  function renderDownload() {
    const info = getModelInfo(MODEL_VARIANT);
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.brandTitle}>Vox</Text>
        <Text style={styles.brandSubtitle}>Dictee medicale privee</Text>

        <View style={{ height: 48 }} />

        <Text style={styles.downloadHeader}>Telechargement du modele vocal</Text>
        <Text style={styles.downloadSize}>{info.sizeLabel}</Text>

        <View style={{ height: 24 }} />

        <Text style={styles.privacyMessage}>
          Ce modele d'intelligence artificielle reste sur votre appareil.
          Vos dictees ne quitteront jamais votre telephone.
        </Text>

        <View style={{ height: 32 }} />

        {state === "downloading" ? (
          <View style={{ alignItems: "center" }}>
            <View style={styles.progressBar}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.round(downloadPercent * 100)}%` },
                ]}
              />
            </View>
            <Text style={styles.progressText}>
              {Math.round(downloadPercent * 100)}%
            </Text>
          </View>
        ) : (
          <TouchableOpacity style={styles.primaryButton} onPress={handleDownload}>
            <Text style={styles.primaryButtonText}>Telecharger</Text>
          </TouchableOpacity>
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
            <View style={[styles.dot, { backgroundColor: COLORS.muted }]} />
            <Text style={styles.statusLabel}>Local</Text>
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
              Appuyez sur le bouton pour commencer la dictee.
            </Text>
          )}
          {latencyMs !== null && (
            <Text style={styles.latency}>
              Derniere transcription: {(latencyMs / 1000).toFixed(1)}s
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
              ? "Toucher pour arreter"
              : "Toucher pour dicter"}
          </Text>
        </View>
      </View>
    );
  }

  // ----- Main render -----

  let content: React.ReactNode;
  if (error) {
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
          <Text style={styles.primaryButtonText}>Reessayer</Text>
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
  recordButtonInner: {
    width: 24,
    height: 24,
    borderRadius: 4,
    backgroundColor: "#fff",
  },
  recordButtonInnerRecording: {
    width: 28,
    height: 28,
    borderRadius: 14,
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
