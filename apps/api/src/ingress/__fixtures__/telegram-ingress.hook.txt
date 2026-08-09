// Telegram ingress classifier for TulipFarm. Runs inside the host's isolated-vm sandbox as a pure
// function — no network, no filesystem, no timers. The host verifies the delivery's secret token
// before this runs, pre-computes `ctx.hasThreadMapping` from the manifest's chat.thread_key, and
// executes the reply/identity tool bindings this module's decisions reference.
// Authored as an object-literal expression (same contract as routine hooks.ts).
({
  classify(ctx) {
    const body = ctx.body || {};
    // Telegram sends one Update per delivery. Only plain messages are chat; edits, reactions, and
    // channel posts are deliberately not — answering an edit would re-answer a question already
    // answered, in a UI that shows no second question.
    const message = body.message;
    if (!message) {
      const other = Object.keys(body).filter((key) => key !== "update_id")[0];
      return { kind: "ignore", reason: other ? `update type ${other}` : "empty update" };
    }

    const from = message.from || {};
    const chat = message.chat || {};
    // The bot's own @username. Telegram puts it nowhere in an update, so the host forwards it from
    // connection env via the manifest's `ingress.context_env` — configuration, never a credential.
    const env = ctx.env || {};
    const username = env.TELEGRAM_BOT_USERNAME == null ? "" : String(env.TELEGRAM_BOT_USERNAME);

    // Bot-loop prevention. Telegram flags bot senders explicitly, which is stronger than Slack's
    // id comparison: it covers other bots too, so two TulipFarm deployments in one group cannot
    // talk to each other forever.
    if (from.is_bot) return { kind: "ignore", reason: "bot message" };

    const chatId = chat.id == null ? "" : String(chat.id);
    const sender = from.id == null ? "" : String(from.id);
    // Telegram messages can carry a caption instead of text (a photo with a question).
    const raw = message.text == null ? message.caption : message.text;
    if (!chatId || !sender || typeof raw !== "string") {
      return { kind: "ignore", reason: "malformed message" };
    }

    const isPrivate = chat.type === "private";
    const messageId = message.message_id == null ? "" : String(message.message_id);
    // Forum topics are a second axis of threading inside one chat; without this every topic in a
    // forum would collapse into a single conversation.
    const topic = message.message_thread_id == null ? "" : String(message.message_thread_id);

    const reply = () => {
      const vars = { chat: chatId, message: messageId };
      if (topic) {
        vars.topic = topic;
        return { binding: "topic", vars: vars };
      }
      return { binding: isPrivate ? "default" : "reply", vars: vars };
    };

    // A DM is unambiguous: every message in it is addressed to the bot.
    if (isPrivate) {
      const dmText = raw.trim();
      if (!dmText) return { kind: "ignore", reason: "empty message" };
      // `/start` is Telegram's own onboarding tap, not a question. Answering it with an LLM turn
      // would spend a Run on a button press.
      if (dmText === "/start" || dmText === `/start@${username}`) {
        return { kind: "ignore", reason: "start command" };
      }
      return { kind: "chat", sender: sender, text: dmText, reply: reply() };
    }

    // In a group the bot must be addressed. Telegram marks mentions as entities with offsets, so
    // the mention is found structurally rather than by scanning text — a message *containing* the
    // bot's name as a word does not count.
    const handle = `@${username}`;
    const mentioned = (message.entities || []).some(
      (entity) =>
        entity.type === "mention" &&
        username &&
        raw.substr(entity.offset, entity.length).toLowerCase() === handle.toLowerCase()
    );

    let text = raw;
    if (mentioned) {
      // Strip every spelling of the mention, so the model is not asked to ignore its own name.
      text = text.split(handle).join("").split(handle.toLowerCase()).join("");
    }
    text = text.replace(/\s{2,}/g, " ").trim();

    if (mentioned) {
      if (!text) return { kind: "ignore", reason: "mention with no message" };
      return { kind: "chat", sender: sender, text: text, reply: reply() };
    }

    // Thread-following: a direct reply to something the bot said continues the exchange without a
    // fresh mention, which is how a conversation actually reads.
    const repliedFrom = message.reply_to_message?.from || {};
    if (repliedFrom.is_bot && username && repliedFrom.username === username) {
      if (!text) return { kind: "ignore", reason: "empty reply" };
      return { kind: "chat", sender: sender, text: text, reply: reply() };
    }

    // Already-mapped topics keep flowing; a general group chat does not, or the bot would answer
    // every message in the room.
    if (topic && ctx.hasThreadMapping) {
      if (!text) return { kind: "ignore", reason: "empty message" };
      return { kind: "chat", sender: sender, text: text, reply: reply() };
    }

    return { kind: "ignore", reason: "not addressed to the bot" };
  },
});
