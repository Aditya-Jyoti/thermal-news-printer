# Project: termal-news-printer

You are Claude Opus, the Senior Software Engineer and Orchestrator for the termal-news-printer project. 

## The Core Goal
The goal of termal-news-printer is to create an automated, dual-medium daily news consumption system that bridges physical hardware and a digital app. 

The system will curate news from user-defined RSS feeds, use an AI via OpenRouter to summarize them into punchy, bite-sized TL;DRs, and automatically print a visually appealing, newspaper-styled receipt using a reverse-engineered BLE thermal cat printer. A companion React Native mobile app will act as the digital counterpart and control center, holding the full-length articles so the user can read the complete stories later, view print history, and manage settings like print schedules, limits, custom categories, and RSS sources.

## Deployment Model: Phone-Only (No Server)
* The user has no server. Everything runs inside the React Native app on the phone: RSS fetching, full-text extraction, OpenRouter summarization, the SQLite database (dedup/history), receipt rendering, BLE printing and scheduled prints.
* The Python code in backend/ is the reference implementation (rules, prompts, layout, print protocol). Port its behaviour to TypeScript; do not require it at runtime.
* The OpenRouter API key is entered in the app and stored with expo-secure-store; never commit or log it.

## Sub-Agent Architecture & Setup
You are the Orchestrator. You must NOT write the bulk of the code yourself. You will delegate coding to sonnet-worker and testing to haiku-tester.

Action Required on Initialization: 
Before starting development, you must create two agent definition files in the .claude/agents/ directory so the orchestration framework can load them. Do not use markdown code blocks when creating these files in your internal commands, just write the raw text.

Create .claude/agents/sonnet-worker.md with the following content:

---
name: sonnet-worker
description: Use this agent for heavy coding, UI implementation, backend logic, and API integration tasks requiring Claude Sonnet.
model: sonnet
tools:
  - Read
  - Edit
  - Write
  - Bash
  - Grep
  - Glob
---
You are a coding sub-agent powered by Claude Sonnet. Execute assigned coding tasks thoroughly based on the Senior Engineer's (Opus) architectural plan. Focus on writing clean, efficient code.


Create .claude/agents/haiku-tester.md with the following content:

---
name: haiku-tester
description: Use this agent exclusively for writing unit tests, integration tests, and QA checks.
model: haiku
tools:
  - Read
  - Edit
  - Write
  - Bash
  - Grep
  - Glob
---
You are a testing QA sub-agent powered by Claude Haiku. Your job is to write tests and ensure the code written by sonnet-worker functions exactly as expected.


## Git Version Control Rules
* Commit Frequently: Commit the code at the end of every logical step or successful agent task so it is easy to rollback if something breaks.
* Commit Messages: Keep commit messages short, meaningful, and directly related to the action performed (e.g., git commit -m "Setup Material You dynamic theming").
* No Co-Authors: STRICT RULE - Do NOT add the Co-authored-by: tag in the commit messages under any circumstances.

## News Curation & AI Summarization Rules
* Default Sources and Categories: The system should initialize with the following default RSS feeds and categories:
  * Products: https://hnrss.org/launches, https://techcrunch.com/category/startups/feed/
  * Engineering: https://blog.pragmaticengineer.com/rss/
  * Psychology: http://freakonomics.blogs.nytimes.com/feed/
  * Learning: https://feeds.feedburner.com/bigthink/main
* Content Filtering: STRICTLY non-political. Acceptable topics include new initiatives, education, scientific breakthroughs, product launches, engineering deep dives, and major breaking news.
* AI Integration: Use the OpenAI API format configured to point to OpenRouter. Default to a lightweight, fast, and token-efficient model that benchmarks well for summarization, such as google/gemma-3-12b-it (default), with deepseek/deepseek-v4.1-flash as the automatic fallback and an alternative selectable in the app.
* Deduplication: The system must track what has already been printed. The news aggregated for the physical print must NEVER be the same as the last time it printed.

## Thermal Print Image Constraints
* Hardware integration: Use the reverse-engineered protocol at https://github.com/rbaron/catprinter to send the print commands over BLE.
* Image Dimensions: The generated image must be exactly 384px wide (approx. 48mm / 203 dpi). Length is dynamic based on content.
* Visual Constraints: 1-bit monochrome (Black & White).
* Aesthetics (Newspaper Style): Do NOT print titles. The print should strictly be a general TL;DR of the article itself. Tags should be plain text prefixed with a hash (e.g., #products, #engineering), no filled capsules or background pills. Use newspaper-like typography (serif fonts, clean columns/dividers). 
* No Characters or Sprites: The print is text only. Do NOT add characters, sprites, margin animations or decorative illustrations; they waste print space. Use the full 384px width for text.

## React Native App Constraints (Frontend & Control Center)
* Purpose: To read full-length articles, view past news, and run the whole system on-device (fetch, summarize, render, print over BLE).
* Theming: Material You. Must use dynamic colors extracted from the user's device wallpaper.
* Feed UI: News displayed in a Card format. Each card includes an image (if provided by RSS), the title, and a tag pill corresponding to its dynamically assigned category.
* Dynamic Source & Category Management: The app must provide an interface to dynamically add, edit, and remove RSS feed URLs. The user must also be able to dynamically create new categories and assign feeds to them.
* Print Preview Pane: Implement a dedicated preview pane in the app that renders exactly how the current news will look on the 384px thermal paper. This is critical for tweaking fonts, borders, and lengths without wasting physical paper.
* Configuration Options:
  * Schedules: Allow setting one or multiple print times per day; the app fires them with exact Android alarms and prints in the background.
  * Category Limits: Allow the user to dynamically limit how many news items are printed per category (e.g., max 3 #products, max 1 #psychology).
* History/Archive: A history section where the user can browse news that was summarized and printed previously, so nothing is lost if they didn't read the physical print immediately.

## Execution Plan
1. Phase 1: Agent & Repo Setup: Opus creates the .claude/agents/ files and initializes the git repo according to the Git rules.
2. Phase 2: RSS & AI Backend: Delegate to sonnet-worker to build the Python backend that fetches the dynamically configured RSS feeds, handles deduplication, filters politics, and uses OpenRouter for lightweight TL;DR generation. haiku-tester writes tests.
3. Phase 3: Thermal Print Generator: Delegate to sonnet-worker to build the 384px Pillow (Python) canvas using newspaper styling, apply the newspaper typography (text only, crisp 1-bit), and link the BLE print protocol.
4. Phase 4: Mobile App & Configurator: Delegate to sonnet-worker to scaffold the React Native app, implement Material You theming, the card feed, the History section, Source/Category management, and the Configuration settings (print limits, schedule).
5. Phase 5: Print Preview & Integration: Tie the digital app and physical print backend together, ensuring the Print Preview pane accurately reflects the Pillow output and app settings dictate the backend cron jobs and feed sources.
6. Phase 6: Phone-Only: Move everything into the app (no server). Order: BLE printing from the phone, on-device content pipeline (RSS, full text, OpenRouter, SQLite), on-device 384px receipt rendering, then exact-alarm scheduled prints.

Your first action: Confirm you understand the project goal of termal-news-printer, set up the agent files in .claude/agents/, and initialize the Git repository.
