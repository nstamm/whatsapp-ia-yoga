# Conversation Flow Maintenance

The admin flow panel is an operational representation of the bot's real conversation behavior. It is not optional documentation.

## Mandatory Rule

Any change to conversation behavior must update all three parts in the same work unit:

1. Runtime behavior in `src/index.js`, `src/claude.js`, or related modules.
2. Nodes, edges, labels, or editable fields in `src/conversationFlow.js`.
3. Contract or behavior tests in `tests/conversationFlow.test.js` and the relevant feature test.

This includes changes to routing, conditions, prompts, messages, media, reminders, payment handling, delivery, handoff, and terminal states.

## Before Delivery

- Run `npm test`.
- Open the admin `Flujo` section and confirm the changed path is visible.
- Confirm editable nodes use the same setting keys consumed at runtime.
- Deploy runtime and flow definition together. Never deploy only one of them.

If a behavior cannot be represented accurately by the current diagram model, extend the model before shipping the behavior.
