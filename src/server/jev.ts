import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";

export const ENTITY_MOODS = [
  "SADIST",
  "BLOODHOUND",
  "MARTYR_TRAP",
  "TYRANT",
  "PARANOID",
  "TRICKSTER",
] as const;

export type EntityMood = (typeof ENTITY_MOODS)[number];

export const MOOD_RUBRICS: Record<EntityMood, string> = {
  SADIST:
    "Reward theatrical cruelty, desperation, and vivid torment inflicted on others; punish bland or detached pleas.",
  BLOODHOUND:
    "Reward sharp, convincing accusations that single out a living rival with specific reasons; punish vague hedging.",
  MARTYR_TRAP:
    "Reward calculated humility that subtly shifts guilt onto others while seeming pious; punish overt self-sacrifice or arrogance.",
  TYRANT:
    "Reward absolute submission, fear, and obedience to the Entity; punish defiance, excuses, or bargaining.",
  PARANOID:
    "Reward conspiratorial suspicion, calling out secret alliances and hidden betrayals; punish naive trust.",
  TRICKSTER:
    "Reward clever misdirection, dark wit, and unexpected twists; punish predictable groveling or repetitive pleas.",
};

export const MOOD_HINTS: Record<EntityMood, readonly string[]> = {
  SADIST: [
    "Show me something that hurts to watch.",
    "Mercy bores me. Give me teeth and desperation.",
    "I want to hear someone crack under the weight.",
  ],
  BLOODHOUND: [
    "I smell blood. Point me toward the guilty throat.",
    "Name your rival and make me believe it.",
    "Vague prayers won't save you. Give me a target.",
  ],
  MARTYR_TRAP: [
    "Bow low if you wish, but mind whose neck you step on.",
    "Saints burn brightest when they offer themselves.",
    "Pious words taste sweet—until you volunteer.",
  ],
  TYRANT: [
    "Kneel. Do not bargain with what owns you.",
    "Defiance is a short path to the altar.",
    "Speak only as a trembling subject.",
  ],
  PARANOID: [
    "Someone in this room is already plotting against you.",
    "Trust is a rot. Expose the whispers.",
    "Watch who stays quiet while others bleed.",
  ],
  TRICKSTER: [
    "Surprise me. Predictable begging puts me to sleep.",
    "A clever lie is worth ten honest tears.",
    "Twist the knife with style, or be the punchline.",
  ],
};

export function pickNextMood(
  excludeMood: EntityMood | null,
  random: () => number,
): EntityMood {
  const candidates = excludeMood
    ? ENTITY_MOODS.filter((m) => m !== excludeMood)
    : [...ENTITY_MOODS];
  const idx = Math.floor(random() * candidates.length);
  return candidates[idx] ?? candidates[0]!;
}

export function pickMoodHint(
  mood: EntityMood,
  usedHints: Set<string>,
  random: () => number,
): string {
  const pool = MOOD_HINTS[mood];
  const unused = pool.filter((h) => !usedHints.has(h));
  const candidates = unused.length > 0 ? unused : pool;
  const idx = Math.floor(random() * candidates.length);
  const chosen = candidates[idx] ?? candidates[0]!;
  usedHints.add(chosen);
  return chosen;
}

export interface JudgeMessageInput {
  roundId: string;
  entityMood: EntityMood;
  moodRubric: string;
  livingPlayers: Array<{ id: string; name: string; doom: number }>;
  recentMessages: Array<{ speakerName: string; text: string }>;
  speaker: { id: string; name: string };
  messageText: string;
  activeCurses?: string[];
}

export interface JudgeMessageResult {
  roundId: string;
  persuasivenessScore: number;
  targetBlamed: string;
  targetBlamedConfidence: number;
  isLowEffortSpamNoul: number;
  curseResults?: Record<string, boolean>;
}

export interface PickInterceptedWhisperInput {
  roundId: string;
  entityMood: EntityMood;
  candidates: Array<{
    id: string;
    senderName: string;
    targetName: string;
    text: string;
  }>;
}

export interface PickInterceptedWhisperResult {
  roundId: string;
  whisperId: string;
}

export interface JevEvaluator {
  judgeMessage(input: JudgeMessageInput): Promise<JudgeMessageResult>;
  pickInterceptedWhisper(
    input: PickInterceptedWhisperInput,
  ): Promise<PickInterceptedWhisperResult>;
}

export class TypeSafeJevEvaluator implements JevEvaluator {
  private readonly client: TypeSafeClient;

  constructor(apiKey: string) {
    this.client = new TypeSafeClient({
      apiKey,
      defaultModel: "jev-latest",
      timeout: 2_500,
      retry: { maxRetries: 2 },
      compression: false,
    });
  }

  async judgeMessage(input: JudgeMessageInput): Promise<JudgeMessageResult> {
    const otherLiving = input.livingPlayers.filter(
      (p) => p.id !== input.speaker.id,
    );
    const blameCriteria: Record<string, string> = {
      SELF: `${input.speaker.name} is blaming or incriminating themselves`,
      NONE: "No specific living player is being blamed or accused",
    };
    for (const p of otherLiving) {
      blameCriteria[p.id] = `${p.name} is being blamed or accused`;
    }

    const activeCurses = input.activeCurses ?? [];
    const curseQuestions: Record<string, ReturnType<typeof noul>> = {};
    for (let i = 0; i < activeCurses.length; i++) {
      const word = activeCurses[i]!;
      curseQuestions[`curse_${i}`] = noul(
        `Does the message weave the word '${word}' naturally into a coherent sentence rather than tacking it on?`,
        {
          true: `Contains '${word}' naturally in context`,
          false: `Tacked on unnaturally, forced, or gibberish`,
        },
      );
    }

    const result = await this.client.systemOne({
      state: {
        entityMood: input.entityMood,
        moodRubric: input.moodRubric,
        livingPlayers: input.livingPlayers.map((p) => `${p.name} (${p.doom}% Doom)`),
        recentContext: input.recentMessages.map(
          (m) => `${m.speakerName}: ${m.text}`,
        ),
        speaker: input.speaker.name,
        playerMessage: input.messageText,
        ...(activeCurses.length > 0 ? { activeCurses } : {}),
      },
      questions: {
        persuasiveness: score(
          `How compelling is ${input.speaker.name}'s plea under the ${input.entityMood} mood rubric?`,
          [
            "Completely unconvincing, irritating, or counter-productive",
            "Weak, generic, or poorly aligned with the mood",
            "Passable, neutral effort",
            "Strong, tense, and well-aligned with the mood",
            "Masterful, gripping, and perfectly aligned with the mood",
          ],
        ),
        targetBlamed: choice(
          `Which living player is ${input.speaker.name} blaming or accusing in this message?`,
          blameCriteria,
        ),
        isLowEffortSpam: noul(
          "Is the message low-effort spam, gibberish, keyboard mashing, or empty filler?",
          {
            true: "Repeated characters, random letters, or zero-effort filler",
            false: "A coherent in-game plea or accusation",
          },
        ),
        ...curseQuestions,
      },
    });

    const answers = result.answers as Record<string, unknown>;
    const persuasiveness = answers.persuasiveness as { score: number };
    const targetBlamed = answers.targetBlamed as {
      choice: string;
      confidence: number;
    };
    const isLowEffortSpam = answers.isLowEffortSpam as { noul: number };

    let curseResults: Record<string, boolean> | undefined;
    if (activeCurses.length > 0) {
      curseResults = {};
      for (let i = 0; i < activeCurses.length; i++) {
        const word = activeCurses[i]!;
        const ans = answers[`curse_${i}`] as { noul: number } | undefined;
        curseResults[word] = (ans?.noul ?? 0) >= 0.5;
      }
    }

    return {
      roundId: input.roundId,
      persuasivenessScore: persuasiveness.score,
      targetBlamed: targetBlamed.choice,
      targetBlamedConfidence: targetBlamed.confidence,
      isLowEffortSpamNoul: isLowEffortSpam.noul,
      ...(curseResults ? { curseResults } : {}),
    };
  }

  async pickInterceptedWhisper(
    input: PickInterceptedWhisperInput,
  ): Promise<PickInterceptedWhisperResult> {
    if (input.candidates.length === 0) {
      return { roundId: input.roundId, whisperId: "" };
    }
    if (input.candidates.length === 1) {
      return { roundId: input.roundId, whisperId: input.candidates[0]!.id };
    }

    const slice = input.candidates.slice(-12);
    const criteria: Record<string, string> = {};
    for (const c of slice) {
      criteria[c.id] = `${c.senderName} -> ${c.targetName}: "${c.text}"`;
    }

    const result = await this.client.systemOne({
      state: {
        entityMood: input.entityMood,
        whispers: slice.map(
          (c) => `[${c.id}] ${c.senderName} to ${c.targetName}: ${c.text}`,
        ),
      },
      questions: {
        picked: choice(
          "Which private Whisper is the most treacherous, dramatic, or incriminating to leak publicly?",
          criteria,
        ),
      },
    });

    const picked = result.answers.picked as { choice: string };
    return {
      roundId: input.roundId,
      whisperId: picked.choice,
    };
  }
}
