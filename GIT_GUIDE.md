# Git Guide - How Git Works

## What is Git?
Git is a version control system that tracks changes in your code. Think of it like a time machine for your code.

## Key Concepts

### 1. **Repository (Repo)**
- Your project folder with Git tracking enabled
- Contains all your code and history

### 2. **Commits**
- Snapshots of your code at a point in time
- Each commit has a unique ID (hash)
- Like saving a checkpoint in a game

### 3. **Branches**
- Different versions of your code
- `main` or `master` is usually the main branch
- You can create branches for features

### 4. **Remote (origin)**
- The version stored on GitHub/GitLab
- `origin` is the default name for your remote repository

### 5. **Working Directory**
- Your current files on disk
- Can have uncommitted changes

## Common Git States

```
┌─────────────────────────────────────┐
│  Remote (GitHub)                    │
│  - Latest version                    │
│  - Shared with others                │
└──────────────┬──────────────────────┘
               │
               │ git pull (download)
               │ git push (upload)
               │
┌──────────────▼──────────────────────┐
│  Local Repository                    │
│  - Your commits                     │
│  - Your history                      │
└──────────────┬──────────────────────┘
               │
               │ git commit (save)
               │ git checkout (restore)
               │
┌──────────────▼──────────────────────┐
│  Working Directory                   │
│  - Your current files                │
│  - Uncommitted changes               │
└─────────────────────────────────────┘
```

## Your Current Situation

**Your local branch is BEHIND origin/main by 1 commit**
- Remote has: 2 commits (Initial + README)
- Your local has: 2 commits but you have uncommitted changes

**You have uncommitted changes:**
- Modified files: `.gitignore`, `package.json`, `src/App.tsx`, etc.
- Deleted: `src/main.ts`
- New files: `server/`, `.env.example`, etc.

## How to Get the First Iteration (Clean Version)

### Option 1: Get Latest from Remote (Recommended)
This gets the latest clean version from GitHub:

```bash
# Save your current work (optional - creates a backup branch)
git stash

# Discard all local changes
git reset --hard origin/main

# Pull latest from remote
git pull origin main
```

### Option 2: Reset to First Commit
This goes back to the very first commit:

```bash
# See all commits
git log --oneline

# Reset to first commit (c6bd2b8)
git reset --hard c6bd2b8
```

### Option 3: Fresh Clone (Safest)
Start completely fresh:

```bash
# Go to parent directory
cd ..

# Rename current folder (backup)
mv production-suite production-suite-backup

# Clone fresh copy
git clone https://github.com/Koala2902/potential-potato.git production-suite

# Copy your .env file from backup if needed
copy production-suite-backup\.env production-suite\.env
```

## Common Git Commands Explained

### Viewing Status
```bash
git status          # See what's changed
git log             # See commit history
git log --oneline   # Compact history
```

### Downloading from Remote
```bash
git fetch           # Download changes (doesn't merge)
git pull            # Download AND merge changes
git pull origin main # Pull from specific branch
```

### Discarding Changes
```bash
git restore <file>           # Discard changes to one file
git restore .                # Discard ALL changes
git reset --hard HEAD        # Reset to last commit
git reset --hard origin/main # Reset to remote version
```

### Saving Changes
```bash
git add <file>      # Stage a file
git add .           # Stage all changes
git commit -m "msg" # Save changes
git push            # Upload to remote
```

## Why You're Getting Errors

**Error: "Your branch is behind origin/main"**
- Solution: Run `git pull` to get latest changes

**Error: "You have uncommitted changes"**
- Git won't let you pull/switch branches with unsaved changes
- Solution: Either commit them or discard them

**Error: "Merge conflicts"**
- Your changes conflict with remote changes
- Solution: Resolve conflicts or reset to remote

## Step-by-Step: Get Clean First Iteration

Here's exactly what to do:

```bash
# 1. Check current status
git status

# 2. Discard all local changes (CAREFUL - this deletes your changes!)
git reset --hard origin/main

# 3. Pull latest from remote
git pull origin main

# 4. Verify you're clean
git status
```

**OR** if you want to keep your changes in a backup:

```bash
# 1. Create a backup branch
git branch backup-my-changes

# 2. Reset to remote
git reset --hard origin/main

# 3. Pull latest
git pull origin main
```

## Visual Example

```
Remote (GitHub):
  Commit 1: Initial commit (c6bd2b8) ← FIRST ITERATION
  Commit 2: Add README (4bca885)   ← LATEST

Your Local:
  Commit 1: Initial commit
  Commit 2: Add README
  + Uncommitted changes (your edits)

After git reset --hard origin/main:
  Commit 1: Initial commit
  Commit 2: Add README
  (clean, matches remote)
```

