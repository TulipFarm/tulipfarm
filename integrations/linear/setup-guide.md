# Connect Linear

TulipFarm uses a Linear personal API key. The key is encrypted in the secrets store and is sent only
to Linear's API for the fixed operations this integration publishes.

1. In Linear, open **Settings → Security & access → Personal API keys**.
2. Create a key for TulipFarm and restrict it to the teams and permissions it needs. Read access is
   enough to list and read issues; enable write, issue creation, or comment creation only when agents
   should perform those actions.
3. In TulipFarm, open **Integrations → Linear**, paste the key, and choose **Connect**.
4. Ask in chat to list Linear teams, then read an issue. Creating, updating, and commenting require
   approval before TulipFarm sends the request.
