/**
 * ライフサイクル reducer（純粋関数）
 * 状態遷移のロジックのみを担当し、副作用は持たない
 */

import type {
  LifeEvent,
  LifeOutput,
  LifeState,
  ReduceResult,
} from "./types.js";

/**
 * 状態とイベントを受け取り、新しい状態と出力を返す純粋関数
 */
export function reduce(state: LifeState, event: LifeEvent): ReduceResult {
  const outputs: LifeOutput[] = [];

  switch (event.type) {
    case "WAKE": {
      if (state.mode === "OFF") {
        return {
          state: { mode: "AWAKE_NOT_WATCHING", focusChannelId: null },
          outputs,
        };
      }
      return { state, outputs };
    }

    case "SLEEP": {
      // 外側が AWAKE_NOT_WATCHING のときだけ投げることを保証する
      if (state.mode === "AWAKE_NOT_WATCHING") {
        return {
          state: { mode: "OFF", focusChannelId: null },
          outputs,
        };
      }
      return { state, outputs };
    }

    case "DISCORD_MESSAGE": {
      // メンション/リプライの場合
      if (event.isMentionOrReplyToAgent) {
        if (state.mode !== "AWAKE_WATCHING") {
          // OFF or AWAKE_NOT_WATCHING → AWAKE_WATCHING
          outputs.push({
            type: "WATCHING_STARTED",
            focusChannelId: event.channelId,
          });
          outputs.push({
            type: "FOCUS_MESSAGE",
            channelId: event.channelId,
            messageId: event.messageId,
          });
          return {
            state: { mode: "AWAKE_WATCHING", focusChannelId: event.channelId },
            outputs,
          };
        }
        // WATCHING中に別チャンネルでメンション → focus切替
        outputs.push({
          type: "FOCUS_MESSAGE",
          channelId: event.channelId,
          messageId: event.messageId,
        });
        return {
          state: { ...state, focusChannelId: event.channelId },
          outputs,
        };
      }

      // 通常メッセージ
      if (
        state.mode === "AWAKE_WATCHING" &&
        state.focusChannelId === event.channelId
      ) {
        // 見ているチャンネルのメッセージだけAIへ渡す
        outputs.push({
          type: "FOCUS_MESSAGE",
          channelId: event.channelId,
          messageId: event.messageId,
        });
      }
      return { state, outputs };
    }

    case "PROMOTE_TO_WATCHING": {
      // 外側が NOT_WATCHING 中だけ投げることを想定
      if (state.mode === "AWAKE_NOT_WATCHING") {
        outputs.push({
          type: "WATCHING_STARTED",
          focusChannelId: event.focusChannelId,
        });
        return {
          state: {
            mode: "AWAKE_WATCHING",
            focusChannelId: event.focusChannelId,
          },
          outputs,
        };
      }
      return { state, outputs };
    }

    case "SET_NOT_WATCHING": {
      if (state.mode === "AWAKE_WATCHING") {
        outputs.push({ type: "WATCHING_ENDED" });
        return {
          state: { mode: "AWAKE_NOT_WATCHING", focusChannelId: null },
          outputs,
        };
      }
      return { state, outputs };
    }

    case "SET_FOCUS_CHANNEL": {
      if (state.mode === "AWAKE_WATCHING") {
        return {
          state: { ...state, focusChannelId: event.channelId },
          outputs,
        };
      }
      return { state, outputs };
    }

    case "ACTIVITY_TICK": {
      // 外側がWATCHING中のみ投げる前提
      if (state.mode === "AWAKE_WATCHING") {
        outputs.push({
          type: "ACTIVITY_DIGEST",
          windowStartMs: event.windowStartMs,
          windowEndMs: event.windowEndMs,
          counts: event.counts,
        });
      }
      return { state, outputs };
    }

    default: {
      // TypeScript exhaustive check
      const _exhaustive: never = event;
      return { state, outputs };
    }
  }
}
