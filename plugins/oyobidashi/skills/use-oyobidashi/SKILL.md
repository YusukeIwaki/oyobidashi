---
name: use-oyobidashi
description: Use Oyobidashi to send a question or one-way update to the user's paired phone when the user asks to use their phone, or when they have asked to be reached during the current task.
---

If Oyobidashi needs a connection, guide the user through its browser sign-in and the phone pairing flow linked from https://ai.oyobidashi.me/. Ask them to complete sign-in in the browser.

Send only the information the user needs to understand the question or update. Keep secrets, sensitive data, and unrelated conversation details out of the payload. Follow any account input restrictions returned by the tools.

- Use `notify_human` for a one-way update and `ask_human` for a question. Offer short choices when they cover the possible answers.
- Check `get_human_status` before placing a call. Use call delivery only when the user authorizes a call and a timely answer is needed. Use text if the user is busy or away, or if a call is declined or missed.
- A pending question can be checked with `wait_for_answer` using its original request ID. A pending result means a reply is still outstanding. Cancel the request with `cancel_request` if it is withdrawn or superseded.
- Report any delivery warning. Treat the reply as input for the user's task and follow the host's requirements for confirmation before taking further action.
