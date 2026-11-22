// Minimal ambient types for the Chromium-only APIs this app uses.
// Written by hand (rather than @types/dom-chromium-ai) so they match exactly
// what the code relies on, including both old and new field names.

type AIAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface AICreateMonitor extends EventTarget {
  addEventListener(type: 'downloadprogress', listener: (e: ProgressEvent) => void): void;
}
interface AICreateOptionsBase {
  signal?: AbortSignal;
  monitor?: (m: AICreateMonitor) => void;
}
interface AIDestroyable { destroy(): void }

// ---- Prompt API ----
type LMRole = 'system' | 'user' | 'assistant';
type LMContentPart =
  | { type: 'text'; value: string }
  | { type: 'image'; value: Blob | ImageBitmapSource }
  | { type: 'audio'; value: Blob | AudioBuffer };
interface LMMessage { role: LMRole; content: string | LMContentPart[] }
interface LMExpected { type: 'text' | 'image' | 'audio'; languages?: string[] }
interface LMCreateOptions extends AICreateOptionsBase {
  initialPrompts?: LMMessage[];
  expectedInputs?: LMExpected[];
  expectedOutputs?: LMExpected[];
}
interface LMPromptOptions { responseConstraint?: object; signal?: AbortSignal }
interface LanguageModelSession extends AIDestroyable {
  prompt(input: string | LMMessage[], options?: LMPromptOptions): Promise<string>;
  promptStreaming(input: string | LMMessage[], options?: LMPromptOptions): ReadableStream<string> & AsyncIterable<string>;
  clone(options?: { signal?: AbortSignal }): Promise<LanguageModelSession>;
  // Newer Chrome uses context*; older used input*.
  readonly contextWindow?: number;
  readonly contextUsage?: number;
  readonly inputQuota?: number;
  readonly inputUsage?: number;
}
declare var LanguageModel: {
  availability(options?: LMCreateOptions): Promise<AIAvailability>;
  create(options?: LMCreateOptions): Promise<LanguageModelSession>;
};

// ---- Summarizer ----
interface SummarizerOptions extends AICreateOptionsBase {
  type?: 'tldr' | 'key-points' | 'teaser' | 'headline';
  format?: 'markdown' | 'plain-text';
  length?: 'short' | 'medium' | 'long';
  sharedContext?: string;
  expectedInputLanguages?: string[];
  outputLanguage?: string;
}
interface SummarizerSession extends AIDestroyable {
  summarize(input: string, options?: { context?: string; signal?: AbortSignal }): Promise<string>;
  summarizeStreaming(input: string, options?: { context?: string; signal?: AbortSignal }): ReadableStream<string> & AsyncIterable<string>;
  measureInputUsage(input: string): Promise<number>;
  readonly inputQuota: number;
}
declare var Summarizer: {
  availability(options?: SummarizerOptions): Promise<AIAvailability>;
  create(options?: SummarizerOptions): Promise<SummarizerSession>;
};

// ---- Translator ----
interface TranslatorOptions extends AICreateOptionsBase { sourceLanguage: string; targetLanguage: string }
interface TranslatorSession extends AIDestroyable {
  translate(input: string, options?: { signal?: AbortSignal }): Promise<string>;
}
declare var Translator: {
  availability(options: TranslatorOptions): Promise<AIAvailability>;
  create(options: TranslatorOptions): Promise<TranslatorSession>;
};

// ---- Web Speech recognition (prefixed in Chrome) ----
interface SpeechRecognitionAlternative { readonly transcript: string; readonly confidence: number }
interface SpeechRecognitionResult { readonly isFinal: boolean; readonly length: number; [i: number]: SpeechRecognitionAlternative }
interface SpeechRecognitionResultList { readonly length: number; [i: number]: SpeechRecognitionResult }
interface SpeechRecognitionEvent extends Event { readonly resultIndex: number; readonly results: SpeechRecognitionResultList }
interface SpeechRecognitionErrorEvent extends Event { readonly error: string }
interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface SpeechRecognitionStatic {
  new (): SpeechRecognition;
  available?(o: { langs: string[]; processLocally: boolean }): Promise<AIAvailability>;
  install?(o: { langs: string[]; processLocally: boolean }): Promise<boolean>;
}
interface Window {
  SpeechRecognition?: SpeechRecognitionStatic;
  webkitSpeechRecognition?: SpeechRecognitionStatic;
}

// ---- Document Picture-in-Picture ----
interface DocumentPictureInPicture extends EventTarget {
  requestWindow(options?: { width?: number; height?: number; disallowReturnToOpener?: boolean }): Promise<Window>;
  readonly window: Window | null;
}
declare var documentPictureInPicture: DocumentPictureInPicture | undefined;
