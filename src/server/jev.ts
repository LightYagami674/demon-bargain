import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";
import { NOOP_LOGGER, type Logger } from "./logger.js";

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

export interface TypeSafeJevClientLike {
  systemOne: (
    request: Parameters<TypeSafeClient["systemOne"]>[0],
    options?: Parameters<TypeSafeClient["systemOne"]>[1],
  ) => Promise<{ answers: Record<string, unknown> }>;
}

export interface TypeSafeJevEvaluatorOptions {
  logger?: Logger;
  clock?: () => number;
  client?: TypeSafeJevClientLike;
}

function extractErrorMeta(err: unknown): {
  errorName: string;
  errorCode: string | number;
} {
  if (err && typeof err === "object") {
    const record = err as {
      name?: unknown;
      code?: unknown;
      status?: unknown;
    };
    const errorName =
      typeof record.name === "string" && record.name.length > 0
        ? record.name
        : "Error";
    const errorCode =
      typeof record.code === "string" || typeof record.code === "number"
        ? record.code
        : typeof record.status === "number"
          ? record.status
          : "UNKNOWN";
    return { errorName, errorCode };
  }
  return { errorName: "UnknownError", errorCode: "UNKNOWN" };
}

export class TypeSafeJevEvaluator implements JevEvaluator {
  private readonly client: TypeSafeJevClientLike;
  private readonly logger: Logger;
  private readonly clock: () => number;

  constructor(apiKey: string, options: TypeSafeJevEvaluatorOptions = {}) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.clock = options.clock ?? (() => Date.now());
    this.client =
      options.client ??
      new TypeSafeClient({
        apiKey,
        defaultModel: "jev-latest",
        timeout: 2_500,
        retry: { maxRetries: 2 },
        compression: false,
      });
  }

  private async runTimedCall<T>(
    operation: "judgeMessage" | "pickInterceptedWhisper",
    roundId: string,
    meta: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = this.clock();
    try {
      const result = await fn();
      this.logger.info("jev_call_completed", {
        operation,
        roundId,
        latencyMs: Math.max(0, this.clock() - startedAt),
        ...meta,
      });
      return result;
    } catch (err) {
      const { errorName, errorCode } = extractErrorMeta(err);
      this.logger.error("jev_call_failed", {
        operation,
        roundId,
        latencyMs: Math.max(0, this.clock() - startedAt),
        errorName,
        errorCode,
        ...meta,
      });
      throw err;
    }
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

    const result = await this.runTimedCall(
      "judgeMessage",
      input.roundId,
      {
        entityMood: input.entityMood,
        curseCount: activeCurses.length,
      },
      () =>
        this.client.systemOne({
          state: {
            entityMood: input.entityMood,
            moodRubric: input.moodRubric,
            livingPlayers: input.livingPlayers.map(
              (p) => `${p.name} (${p.doom}% Doom)`,
            ),
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
        }),
    );

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

    const result = await this.runTimedCall(
      "pickInterceptedWhisper",
      input.roundId,
      {
        entityMood: input.entityMood,
        candidateCount: slice.length,
      },
      () =>
        this.client.systemOne({
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
        }),
    );

    const picked = result.answers.picked as { choice: string };
    return {
      roundId: input.roundId,
      whisperId: picked.choice,
    };
  }
}
