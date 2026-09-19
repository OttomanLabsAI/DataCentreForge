---
name: git-ai-instruct-injection
description: Inject the AI instructions behind every shipped version into the git build - the folder "prompt text/N/" committed with version N, holding the exact prompt that produced it (input.txt), the exact reply that shipped it (output.txt), the model attribution (ai model.txt) and every file or image the owner supplied, swapped in wholesale with each release so the repository carries only the version in service. Use this in any project whenever a version is about to be committed for release, pushed to main, merged or tagged - in a repository that keeps a "prompt text" folder or whose CLAUDE.md mentions one, and in a new project of the owner's, where the archive starts at version 1; whenever the owner says "save the prompt", "prompt text", "prompt in and out", "archive the conversation", "keep the prompt with the tag", "instruct injection" or asks whether the prompt was saved. Apply it even when the request is only "ship it" or "push this" - populating the archive is part of releasing, in the same commit.
---

# Git AI-instruct injection

Every shipped version of a project keeps the words that made it, committed
alongside the code they produced. Anyone opening the release later can read
the exact prompt the owner gave, the exact reply that shipped it, which model
did the work, and can open the files the owner supplied. The records are the
owner's: copied as supplied, never tidied, trimmed, reformatted or
reconstructed. It is the same habit in every project it is used in, so the
archives read alike across a portfolio.

The `release-workflow` skill (if present) says how a release is versioned and
announced; this skill says what goes into the archive alongside it. They are
done together, in one commit, and the archive is never a follow-up.

## The layout

```
prompt text/
  N/
    input.txt        the prompt that produced version N, byte for byte
    output.txt       the reply that shipped it, byte for byte
    ai model.txt     three lines: the maker, the model family, the model
    <files>          anything the owner attached: images, exports, drawings
```

The folder name has a space in it: `prompt text`. Quote it in every command.

`N` is the owner's version number for this project: a running count of the
prompts that have shipped, one more than the folder in service. It is not the
release tag. A project may be at tag v2.13 and prompt 29, because some pushes
ship no new prompt (a cache-stamp fix, a ledger correction, a rename), and
those releases leave the archive exactly as it is. Every project counts from
its own 1.

## Only the version in service

The folder holds one version at a time. Shipping N removes the previous
folder(s) and adds `N/`, in the same commit that releases the version. Nothing
is lost: every earlier record stays in the tree of the release that shipped it,
and `git show <release-commit>:"prompt text/<n>/input.txt"` brings any of them
back. Keeping only the current one keeps the repository light and makes "the
archive" mean "the words behind what is live".

## What each file holds

**input.txt** - the owner's words exactly as received. When several messages
together produced one version (a request, then "also do X", then "actually,
call it Y"), put them all in, in order, separated by one blank line, each
verbatim. Typos, casing and spacing are the owner's and stay. Attachment
tokens a client inserts into a message (`@"/some/upload/path/…"`, an
`[Image: source: …]` marker) are not the owner's words: leave them out and
copy the file itself alongside. Write it as soon as the request is
understood, before the work, so the record cannot drift from what was asked.

**output.txt** - the reply that ships the version, as sent: the prose that
describes the version, including its "verified" paragraph. The release-tag
block (Tag / Title / Description) lives in the ledger and on the release page,
not here. Write it last, once the reply is final and before committing, so the
file and the message are identical.

**ai model.txt** - three lines: maker, model family, model. Unless the owner
directs otherwise for a version it reads:

```
Anthropic
Claude
Fable 5 Max
```

If a version was in fact produced with another model, say so truthfully on
the same three lines; the owner may also dictate the wording for a version.

**Attached files** - every file the owner supplied for that version, under
the owner's own file name. Uploads arrive with a hash prefix on the name
(`54befd40-DCBuildmanholes.json`): strip the prefix and keep the rest. A
picture the client saved to disk (`1.webp`, `2.png`) is a file and is kept
under that name. A picture that only ever arrived as pixels in the message
cannot be copied: archive the words, and say in the reply that the image could
not be saved, rather than staying silent.

## The scripts do the mechanical part

The scripts live beside this file in `scripts/` and work from anywhere inside
the repository. Each does one thing and refuses to do it wrongly.

```bash
scripts/archive.sh next            # or a number: remove the folder in service, start N, write ai model.txt
scripts/put.sh N input <<'TEXT'    # the prompt, verbatim, on standard input
the owner's words
TEXT
scripts/attach.sh N /path/to/54befd40-drawing.json   # copies as drawing.json
# … the work, the verification, the reply drafted …
scripts/put.sh N output <<'TEXT'   # the reply, as it will be sent
…
TEXT
scripts/check.sh                   # one folder, three sound records, every file staged
```

`archive.sh next` reads the folder in service and starts the one after it;
give the number instead when the folder is missing or the owner has said which
version this is. `archive.sh N Anthropic Claude "Opus 5"` writes a different
attribution. `put.sh` takes the text on standard input so nothing is
re-quoted or escaped on the way in, and drops exactly the one trailing
newline a here-document adds, so the file holds the words and nothing else.
`attach.sh` strips a hash prefix and keeps everything after it. `check.sh`
fails, with a plain reason, on anything a reader would trip over: two
folders, an empty record, a model file that is not three lines, a file not
yet staged.

Then commit the archive together with the code, the ledger row and the
release stamp, and push.

## Never after the fact

Never edit an archived file later, never "fix" one, and never regenerate one
from memory. If the exact text of a prompt or reply is no longer available (a
session was summarised, a file was lost), record what is certain and say
plainly in the reply what is missing. A gap that is admitted is a record; a
gap that is filled in from memory is a forgery.

## Starting the archive in a new project

When a project should begin keeping the archive, create `prompt text/1/` for
the version being shipped and add the policy to the repository's CLAUDE.md so
every later session keeps it, creating the file with just this if there is
none, in words like these:

> `prompt text/` holds the records for the version currently in service -
> nothing else. Shipping version N replaces the folder's contents wholesale,
> in the same push that releases the version: remove the previous version's
> folder(s) and add `prompt text/N/` containing `input.txt` (the prompt, byte
> for byte), `output.txt` (the reply that shipped it, byte for byte),
> `ai model.txt` (three lines: Anthropic / Claude / Fable 5 Max unless the
> owner directs otherwise) and any input images or files the owner provided.
> The files are owner-supplied records: never edit, reformat, trim or
> regenerate them.

Copying the skill's `scripts/` folder into the repository is optional: the
scripts run from wherever the skill lives, and the habit is fully described
above for a session that has only the CLAUDE.md paragraph.

## Before pushing, check

- the previous folder is gone and `prompt text/N/` is the only one
- `input.txt` is the owner's words and nothing else, every message that shaped
  the version, in order
- `output.txt` equals the reply being sent, prose only
- `ai model.txt` has its three lines
- every file the owner supplied is there under its own name; anything that
  could not be saved is named in the reply
- the archive is in the same commit as the release - `scripts/check.sh` says
  when it is not
