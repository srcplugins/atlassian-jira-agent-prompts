# Changelog

User-facing changes in each released version of Agent Prompts for Jira.

## 1.0.0 (unreleased)

First release.

- **Prompts as Jira work items.** Keep coding standards, review checklists and reusable instructions as ordinary work items of a prompt work type: the summary is the name and the description holds the instructions.
- **Agent Prompts field.** Pick up to five prompts on a work item. Saving copies their instructions into a collapsible section of its description; **Sync** brings in later source edits when you choose, and removing a prompt removes its copy.
- **Prompt search.** The field suggests the newest prompts and searches by name or key.
- **Space configuration.** A guided setup for one or many company-managed software spaces: use an existing work type or create one, review the Jira changes before applying, check each space's health, repair or replace the type, remove a space's setup, and optionally reload work items after saving.
- **Rovo agent.** The read-only Agent Prompts Assistant finds prompts and reads their instructions back.
- **Safe saves and setup.** Interrupted saves and configuration runs are detected and can be checked and resolved without repeating a Jira change.
- **Jira permissions apply.** The app acts as the signed-in user, so people only see and change what Jira already allows.
