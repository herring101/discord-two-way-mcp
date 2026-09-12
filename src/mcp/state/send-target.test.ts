import { afterEach, describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import { TextChannel } from "discord.js";
import {
  clearSendTarget,
  getSendTarget,
  setSendTarget,
} from "./send-target.js";

afterEach(() => {
  clearSendTarget();
});

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createClient(
  sendTyping: (channelId: string) => Promise<void>,
): Client {
  return {
    channels: {
      fetch: async (channelId: string) => {
        const channel = Object.create(TextChannel.prototype) as TextChannel;
        channel.sendTyping = () => sendTyping(channelId);
        return channel;
      },
    },
  } as unknown as Client;
}

describe("send target state", () => {
  test("a slower earlier typing request cannot overwrite a newer target", async () => {
    const firstTyping = deferred();
    const firstStarted = deferred();
    const client = createClient(async (channelId) => {
      if (channelId === "first") {
        firstStarted.resolve();
        await firstTyping.promise;
      }
    });

    const first = setSendTarget(client, { channelId: "first" });
    await firstStarted.promise;

    await setSendTarget(client, { channelId: "second" });
    expect(getSendTarget()).toEqual({ channelId: "second" });

    firstTyping.resolve();
    await first;
    expect(getSendTarget()).toEqual({ channelId: "second" });
  });

  test("clear invalidates an in-flight typing request", async () => {
    const typing = deferred();
    const started = deferred();
    const client = createClient(async () => {
      started.resolve();
      await typing.promise;
    });

    const setting = setSendTarget(client, { channelId: "channel" });
    await started.promise;
    clearSendTarget();

    typing.resolve();
    await setting;
    expect(getSendTarget()).toBeNull();
  });
});
