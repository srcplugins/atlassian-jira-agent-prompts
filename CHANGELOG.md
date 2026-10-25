# Changelog

User-facing changes in each released version of Agent Prompts for Jira.

## 1.0.5

- **Paid subscription.** Agent Prompts for Jira is now a paid app, billed through Atlassian, with a free trial. Without an active subscription the field and the Rovo assistant can't search, save or sync prompts, and spaces can't be configured; removing setup, health checks and recovery of interrupted changes stay available, and nothing stored is lost.
- **Jira's own field editors.** This README now says that bulk edit, the list view's Edit fields, boards and the REST API can change the Agent Prompts field without updating the description, and that Save and Sync replace such changes with the prompts last saved through the app.
- **Demo video.** "Watch the demo" in this README plays the current demo, recorded on the released app.

## 1.0.4

- **Sync always fixes the Agent Prompts section.** Save and Sync replace every collapsible section titled Agent Prompts in the description with one fresh section from the prompts the field links, wherever those sections are and whatever anyone edited, typed, moved, copied or deleted. They no longer refuse and ask you to undo a change in Jira first. The rest of the description stays as it is.
- **Deleted prompts.** A linked prompt that was deleted, never existed or is no longer a prompt in the space is removed from the field and the section, and the field says which. Only a linked prompt you aren't allowed to see stops a save, with a message saying so; nothing is changed.
- **Sync without saved prompts.** Sync is available even when the field links no prompts, so it can remove an Agent Prompts section someone added by hand.
- **Unconfirmed saves.** A save whose response was lost settles by itself when Jira shows it landed: the field changed to exactly the prompts it saved, or the description and field are exactly what it wrote. An administrator can release any other after two minutes, keeping the last saved prompts; Sync then rewrites the section. The "Use its prompts" and accept choices from 1.0.2 are gone.

## 1.0.2

- **Jira's Create form.** The Agent Prompts field is no longer on Jira's Create form, so the form never waits for it to load. Add prompts once the work item exists.
- **Sections saved by Jira's editor.** Jira's editor can add its own markers inside the Agent Prompts section when it saves a description. Save, Sync and removing prompts now accept them, so the field no longer refuses a section nobody changed. When a section really was changed, the message says how to restore it.
- **Untracked Agent Prompts sections.** When a description holds an Agent Prompts section the field doesn't track, such as one copied from another work item, the field lists it with links to the prompts it names and doesn't write a second section beside it. Use its prompts and save, or delete it in Jira, to replace it.
- **Security.** markdown-it 14.3.3, for two denial-of-service advisories.

## 1.0.1

- **Jira's Create form.** Where the Agent Prompts field is on a Create form, it now says to add prompts after you create the work item, instead of showing Jira's own list editor, and the work item is created with the field empty.

## 1.0.0

First release.

- **Prompts as Jira work items.** Keep coding standards, review checklists and reusable instructions as ordinary work items of a prompt work type: the summary is the name and the description holds the instructions.
- **Agent Prompts field.** Pick up to five prompts on a work item. Saving copies their instructions into a collapsible section of its description; **Sync** brings in later source edits when you choose, and removing a prompt removes its copy.
- **Prompt search.** The field suggests the newest prompts and searches by name or key.
- **Retired prompts.** Move a prompt to a status in Jira's Done category and the field and the Rovo agent stop suggesting it; work items that already use it keep it, labeled "(retired)", and Sync still copies it.
- **Space configuration.** A guided setup for one or many company-managed software spaces: use an existing work type or create one, choose per space which work types show the Agent Prompts field on their screens, review the Jira changes (including shared screens) before applying, check each space's health, repair or replace the type, remove a space's setup, and optionally reload work items after saving.
- **Team-managed spaces.** After a space admin adds the field and creates the prompt work type in Space settings, choose the space's own type in the space configuration (on its own tab when the site has both kinds of space), in a one-screen setup with a confirmation; nothing changes in Jira, and the list and the space's details show which work types have the field on their layout.
- **Rovo agent.** The read-only Agent Prompts Assistant finds prompts and reads their instructions back.
- **Safe saves and setup.** Interrupted saves and configuration runs are detected and can be checked and resolved without repeating a Jira change.
- **Jira permissions apply.** The app acts as the signed-in user, so people only see and change what Jira already allows.
