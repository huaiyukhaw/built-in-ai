// Speaker names. Each source (room mic, remote audio) carries the name of whoever last introduced
// themselves on it, until someone else does. The model then sees "Priya (Remote): I will …" instead
// of "Remote: I will …", which is what owners in the minutes depend on.
import type { Segment, SegmentSource } from './model';

export const sourceLabel = (source: SegmentSource) => (source === 'tab' ? 'Remote' : 'Room');

/** Shown and given to the model: "Priya (Remote)", or just "Remote" when no name is known. */
export const speakerLabel = (s: Segment) => (s.speaker ? `${s.speaker} (${sourceLabel(s.source)})` : sourceLabel(s.source));

// Capitalised words that start a phrase like "this is …" or "… here" without being a name.
const NOT_NAMES = new Set([
  'i', 'im', 'ok', 'okay', 'yes', 'yeah', 'no', 'so', 'and', 'but', 'just', 'still', 'sorry', 'thanks', 'thank', 'good', 'great',
  'everyone', 'everybody', 'all', 'team', 'guys', 'folks', 'hi', 'hello', 'hey', 'morning', 'afternoon', 'evening', 'welcome',
  'actually', 'well', 'wait', 'anyway', 'finally', 'last', 'one', 'sure', 'quick', 'please', 'what', 'who', 'how', 'why', 'when', 'where', 'can', 'could', 'should', 'do', 'does', 'is', 'are',
  'the', 'a', 'an', 'this', 'that', 'it', 'we', 'you', 'they', 'he', 'she', 'not', 'also', 'back', 'right', 'here', 'there', 'now', 'again',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'today', 'tomorrow',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'room', 'remote', 'unknown', 'speaker', 'microsoft', 'teams', 'zoom', 'google',
]);
// Titles stay in the spoken name ("Encik Razak") but a title alone isn't a name.
const TITLES = new Set(['mr', 'mrs', 'ms', 'dr', 'encik', 'cik', 'puan', 'tuan', 'datuk', 'dato', 'datin', 'madam', 'prof']);

const WORD = String.raw`[A-Z][\p{L}'’-]*`;
const NAME = String.raw`(${WORD}(?:\s+${WORD}){0,3})`;
const GREETING = String.raw`(?:(?:hi|hello|hey|morning|good morning|good afternoon|okay|ok|yes|yeah|sorry)[\s,.!]*(?:everyone|all|guys|team|folks)?[\s,.!]*)*`;
// "this is Priya", "it's Aisha", "I'm Daniel": only at the start of a sentence or after a greeting,
// so "so this is Monday's plan" or "I'm Sure" mid-sentence don't count. "My name is" can be anywhere.
const LEAD = new RegExp(String.raw`(?:^|[.!?,]\s*)${GREETING}(?:this is|it's|it’s|it is|i'm|i’m|i am)\s+${NAME}`, 'iu');
const MY_NAME = new RegExp(String.raw`\bmy name(?:'s|’s| is)\s+${NAME}`, 'iu');
// "Daniel here", "Razak speaking", "Daniel again": at the start of the line, after a greeting.
const TRAIL = new RegExp(String.raw`^${GREETING}${NAME}\s+(?:here|speaking|again)\b`, 'iu');
// "Lim Wei Jie, you're handling the comms?": a question put to someone by name, at the start of a sentence.
const ASK = new RegExp(String.raw`(?:^|[.!?]\s+)(?:(?:okay|ok|so|and|good|great|thanks)[\s,.!]+)?${NAME},\s+[^.!?]*\?`, 'u');

/** False for capitalised words that start sentences without being names ("Just", "Okay", "Monday"). */
export const couldBeName = (word: string) => /^\p{Lu}/u.test(word) && !NOT_NAMES.has(word.toLowerCase().replace(/['’-]/g, ''));

/** Keep the capitalised words of a match that make up a name, dropping filler like "Here". */
function cleanName(raw: string): string {
  const words: string[] = [];
  for (const w of raw.split(/\s+/)) {
    if (!couldBeName(w)) break;
    words.push(w.replace(/['’]s$/, ''));
  }
  while (words.length && TITLES.has(words[0].toLowerCase())) words.shift();
  return words.join(' ');
}

const firstName = (re: RegExp, text: string) => {
  const m = re.exec(text);
  return m ? cleanName(m[1]) : '';
};

/** The name someone gives for themselves in this line ("Hi, this is Priya from QA" → "Priya"), or "". */
export function introducedName(text: string): string {
  return firstName(TRAIL, text) || firstName(LEAD, text) || firstName(MY_NAME, text);
}

/** A person asked a question by name ("Muthu, can you check?" → "Muthu"), who is likely to answer next. */
export function addressedName(text: string): string {
  let name = '';
  for (const m of text.matchAll(new RegExp(ASK, 'gu'))) name = cleanName(m[1]) || name;
  return name;
}

/**
 * The speaker for a new line from `source`: a name it introduces, else the person the other
 * source just asked by name, else whoever spoke last on this source.
 */
export function nextSpeaker(segments: Segment[], source: SegmentSource, text: string): string | undefined {
  const intro = introducedName(text);
  if (intro) return intro;
  const last = segments.at(-1);
  if (last && last.source !== source) {
    const asked = addressedName(last.text);
    if (asked) return asked;
  }
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].source === source) return segments[i].speaker;
  }
  return undefined;
}

/** Fill in speakers for segments that came without one (eval samples, meetings from before names). */
export function labelSpeakers(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    const speaker = s.speaker ?? nextSpeaker(out, s.source, s.text);
    out.push(speaker ? { ...s, speaker } : s);
  }
  return out;
}

/**
 * Rename the speaker of segments[index] and the run of lines around it that had the same label
 * on the same source (lines from the other source in between don't break the run). An empty
 * name goes back to the source label (stored as "" so it isn't guessed again). Returns the indexes that changed.
 */
export function renameSpeaker(segments: Segment[], index: number, name: string): number[] {
  const target = segments[index];
  if (!target) return [];
  const old = target.speaker;
  const next = name.trim();
  const run: number[] = [];
  const sameRun = (i: number) => segments[i].source !== target.source || segments[i].speaker === old;
  for (let i = index; i >= 0 && sameRun(i); i--) if (segments[i].source === target.source) run.push(i);
  for (let i = index + 1; i < segments.length && sameRun(i); i++) if (segments[i].source === target.source) run.push(i);
  for (const i of run) segments[i].speaker = next;
  return run.sort((a, b) => a - b);
}
