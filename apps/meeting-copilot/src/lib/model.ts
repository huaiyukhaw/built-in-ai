export type SegmentSource = 'mic' | 'tab';

export interface Segment {
  id: string;
  /** ms since epoch when the segment was finalised */
  at: number;
  source: SegmentSource;
  text: string;
  /** Caption-language translation; undefined while pending, null if unavailable */
  translation?: string | null;
}

export interface ActionItem { owner: string; task: string; due: string }

export interface Minutes {
  generatedAt: number;
  summary: string; // markdown from the Summarizer
  decisions: string[];
  actionItems: ActionItem[];
  openQuestions: string[];
  /** Set when only part of the minutes could be generated, e.g. no Prompt API for action items */
  partial?: string;
}

export interface Meeting {
  id: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  /** BCP-47 locale the meeting is spoken in, e.g. "en-US" */
  spokenLocale: string;
  /** Language captions are translated into, e.g. "zh" */
  captionLang: string;
  segments: Segment[];
  minutes?: Minutes;
}

export const SPOKEN_LOCALES: { locale: string; label: string }[] = [
  { locale: 'en-US', label: 'English' },
  { locale: 'zh-CN', label: 'Mandarin' },
  { locale: 'ja-JP', label: 'Japanese' },
  { locale: 'es-ES', label: 'Spanish' },
  { locale: 'ms-MY', label: 'Malay' },
  { locale: 'ta-IN', label: 'Tamil' },
];

export const CAPTION_LANGS: { lang: string; label: string }[] = [
  { lang: 'en', label: 'English' },
  { lang: 'zh', label: 'Chinese (Simplified)' },
  { lang: 'ta', label: 'Tamil' },
  { lang: 'id', label: 'Indonesian' },
  { lang: 'ja', label: 'Japanese' },
  { lang: 'es', label: 'Spanish' },
];

/** Prompt API output languages, which bounds what tab-audio transcription can produce. */
export const PROMPT_LANGS = ['en', 'es', 'ja'];

export const langOf = (locale: string) => locale.split('-')[0];

export function newMeeting(spokenLocale: string, captionLang: string, now = Date.now()): Meeting {
  const d = new Date(now);
  return {
    id: crypto.randomUUID(),
    title: `Meeting ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`,
    startedAt: now,
    spokenLocale,
    captionLang,
    segments: [],
  };
}
