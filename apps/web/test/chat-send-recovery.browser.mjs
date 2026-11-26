import { registerChatSendRecoveryTests } from './chat-send-recovery.fixture.mjs';

registerChatSendRecoveryTests({ shard: process.env.CHAT_SEND_SCENARIO ? undefined : [1, 2] });
