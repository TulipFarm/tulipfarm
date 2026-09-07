# Connect Trello

## Create the credentials

1. Open Trello's [API key page](https://trello.com/power-ups/admin).
2. Copy the API key.
3. Select the token link on that page. Give it only the access you need, then copy the token.

Keep both values private. The token acts as the Trello member that created it.

## Connect it

Open **Integrations → Trello → Connect**.

- Paste the API key into **Trello API key**.
- Paste the token into **Trello token**.

TulipFarm stores both as encrypted secrets. Each Trello call sends both values directly to Trello.

## What agents can do

| Tool | What it does |
| --- | --- |
| `trello_get_member` | Confirms the credentials and reads the connected Trello member. |
| `trello_list_boards` | Lists boards the connected member can access. |
| `trello_list_lists` | Lists the open or closed lists on one board. |
| `trello_list_cards` | Lists cards in one list. |
| `trello_create_card` | Creates a card in one list. |
| `trello_update_card` | Updates a card or moves it to another list. |
