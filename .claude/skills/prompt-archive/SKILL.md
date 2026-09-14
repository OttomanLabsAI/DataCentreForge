---
name: prompt-archive
description: Keep the provenance archive that travels with every shipped version of an owner's project - the folder "prompt text/N/" holding the exact prompt that produced version N (input.txt), the reply that shipped it (output.txt), the model attribution (ai model.txt) and every file or image the owner supplied, swapped in wholesale with each release so the repository carries only the version in service. Use this whenever a version is about to be shipped, released, pushed to main, merged or tagged in a repository that has a "prompt text" folder or whose CLAUDE.md mentions one; whenever the owner says "save the prompt", "prompt text", "archive the conversation", "keep the prompt with the tag" or asks whether the prompt was saved; and when a new repository should start keeping such an archive. Apply it even when the request is only "ship it" or "push this" - the archive is part of releasing.
---

# Prompt archive

Every shipped version of the project keeps the words that made it. That is the
whole idea: anyone opening the release later can read the exact prompt the
owner gave, the exact reply that shipped it, and which model did the work, and
can open the files the owner supplied. The records are the owner's, so they are
copied as supplied and never tidied, trimmed, reformatted or reconstructed.

The `release-workflow` skill (if present) says how a release is versioned and
announced; this skill says what goes into the archive alongside it. Do both in
the same push.

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

`N` is the owner's version number: a running count of the prompts that have
shipped, one more than the folder in service. It is not the release tag. A
project may be at tag v2.13 and prompt 29, because some pushes ship no new
prompt (a cache-stamp fix, a ledger correction, a rename). Those releases leave
the archive exactly as it is.

## Only the version in service

The folder holds one version at a time. Shipping N removes the previous
folder(s) and adds `N/`, in the same commit that releases the version. Nothing
is lost: every earlier record stays in the tree of the release that shipped it,
and `git show <release-commit>:"prompt text/<n>/input.txt"` brings any of them
back. Keeping only the current one is what keeps the repository light and makes
"the archive" mean "the words behind what is live".

## What each file holds

**input.txt** - the owner's words exactly as received. When several messages
together produced one version (a request, then "also do X", then "and make it
work on the iPad"), put them all in, in order, separated by one blank line, each
verbatim. Typos, casing and spacing are the owner's and stay. Attachment tokens
a client inserts into a message (`@"/some/upload/path/…"`) are not the owner's
words: leave them out and copy the file itself alongside. Write the file with
something that adds nothing, such as `printf '%s'` or a quoted heredoc, and
check the byte count against the message if in doubt.

**output.txt** - the reply that shipped the version, as sent. Write it when the
reply is final and before committing, so the two are identical. The release-tag
block (Tag / Title / Description) lives in the ledger and on the release page,
not here; the archived reply is the prose that describes the version, including
its "verified" paragraph.

**ai model.txt** - three lines: maker, model family, model. Unless the owner
directs otherwise it reads:

```
Anthropic
Claude
Fable 5 Max
```

If a version was in fact produced with another model, say so truthfully on the
same three lines; the owner may also dictate the wording for a version.

**Attached files** - copy each file the owner supplied for that version, under
the owner's own file name. Uploads often arrive with a hash prefix on the name
(`54befd40-DCBuildmanholes.json`); strip the prefix and keep the rest. A picture
pasted inline into a message arrives as pixels, not a file, and cannot be
copied: archive the words, and say in the reply that the image could not be
saved, rather than staying silent.

## When and how

Do this as part of the release, never as a follow-up commit:

```bash
# from the repository root, N being the new version number
git rm -rq "prompt text/<previous N>"          # every folder that is there
mkdir -p "prompt text/N"
printf '%s' '<the prompt, verbatim>' > "prompt text/N/input.txt"
printf 'Anthropic\nClaude\nFable 5 Max\n'    > "prompt text/N/ai model.txt"
cp "/path/to/upload/abcd1234-drawing.json"    "prompt text/N/drawing.json"
# … write output.txt last, once the reply is final …
git add "prompt text"
```

`scripts/archive.sh N` does the swap and writes the model file in one go; the
prompt, the reply and the attachments still need writing by hand because they
are arbitrary text. Then commit together with the code, the ledger row and the
stamp bump, and push.

Never edit an archived file after the fact, never "fix" one, and never
regenerate one from memory. If the exact text of a prompt or reply is no longer
available (a session was summarised, a file was lost), record what is certain
and say plainly in the reply what is missing. A gap that is admitted is a
record; a gap that is filled in from memory is a forgery.

## Starting an archive in a new repository

When a repository should begin keeping the archive, create `prompt text/1/`
for the version being shipped and add the policy to the repository's CLAUDE.md
so every later session keeps it, in words like these:

> `prompt text/` holds the records for the version of the page currently in
> service - nothing else. Shipping version N replaces the folder's contents
> wholesale, in the same push that releases the version: remove the previous
> version's folder(s) and add `prompt text/N/` containing `input.txt` (the
> prompt, byte for byte), `output.txt` (the reply that shipped it, byte for
> byte), `ai model.txt` (three lines: Anthropic / Claude / Fable 5 Max unless
> the owner directs otherwise) and any input images or files the owner
> provided. The files are owner-supplied records: never edit, reformat, trim
> or regenerate them.

## Before pushing, check

- the previous folder is gone and `prompt text/N/` is the only one
- `input.txt` is the owner's words and nothing else, every message that shaped
  the version, in order
- `output.txt` equals the reply being sent, prose only
- `ai model.txt` has its three lines
- every file the owner supplied is there under its own name; anything that
  could not be saved is named in the reply
- the archive is in the same commit as the release
