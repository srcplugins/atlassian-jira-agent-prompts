# Changelog

User-facing changes in each released version of Agent Prompts for Jira.

## 1.0.0 (unreleased)

First release.

- **Prompts as Jira issues.** Keep coding standards, review checklists and reusable instructions as ordinary issues of a prompt issue type: Summary is the name, Description holds the instructions.
- **Agent Prompts field.** Pick up to five prompts on a work issue. Saving copies their instructions into a collapsible section of its Description; **Sync** brings in later source edits when you choose, and removing a prompt removes its copy.
- **Prompt search.** The field suggests the newest prompts and searches by name or issue key.
- **Prompt Library.** A project page under **Apps** to browse and search a project's prompts and create new ones.
- **Project configuration.** A guided setup for one or many company-managed Software projects: use an existing issue type or create one, review the Jira changes before applying, check each project's health, repair or replace the type, unlink projects, and optionally reload tickets after saving.
- **Rovo agents.** Two read-only agents: Agent Prompts Assistant finds prompts and reads their instructions back; Ticket Description Summary summarizes a ticket's Description.
- **Safe saves and setup.** Interrupted saves and configuration runs are detected and can be checked and resolved without repeating a Jira change.
- **Jira permissions apply.** The app acts as the signed-in user, so people only see and change what Jira already allows.
