---
name: reactions
description: React to WhatsApp messages with emoji. Use when the user asks you to react, when acknowledging a message with a reaction makes sense, or when you want to express a quick response without sending a full message.
---

# Reactions

React to messages with emoji using the `mcp__nanoclaw__add_reaction` tool.

## When to use

- User explicitly asks you to react ("react with a thumbs up", "heart that message")
- Quick acknowledgment is more appropriate than a full text reply
- Expressing agreement, approval, or emotion about a specific message

## How to use

### React to the latest message

Use the numeric message id shown in the prompt, for example `#22`.

### React to a specific message

```
mcp__nanoclaw__add_reaction(messageId: 22, emoji: "heart")
```

Pass `messageId` as an integer, not a string. Pass `emoji` as the shortcode name, not the raw emoji.

### Remove a reaction

Send an empty string to remove your reaction:

```
mcp__nanoclaw__add_reaction(messageId: 22, emoji: "")
```

## Common emoji

| Emoji | When to use |
|-------|-------------|
| 👍 | Acknowledgment, approval |
| ❤️ | Appreciation, love |
| 😂 | Something funny |
| 🔥 | Impressive, exciting |
| 🎉 | Celebration, congrats |
| 🙏 | Thanks, prayer |
| ✅ | Task done, confirmed |
| ❓ | Needs clarification |
