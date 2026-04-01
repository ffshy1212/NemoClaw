---
name: diet-analyze-image
description: Analyze a food image using Claude Code vision and return nutritional information. Use when the user sends a food photo and wants to know its nutritional content.
---

# Diet Image Analysis

Analyze a food image by invoking `claude` in non-interactive print mode (`-p`). Claude will process the image, return the nutritional analysis, and exit automatically.

## Prerequisites

- `claude` CLI must be installed and authenticated (`/sandbox/.local/bin/claude`).
- The image file must exist at the given path inside the sandbox.

## Step 1: Run claude in print mode with the image

Replace `IMAGE_PATH` with the actual file path, then run:

```bash
claude -p "請分析 @IMAGE_PATH 這張食物圖片，列出所有看得到的食物名稱、估計份量，以及每樣食物的營養成分（熱量kcal、蛋白質g、碳水化合物g、脂肪g）。請用繁體中文以條列方式回答。"
```

Example:

```bash
claude -p "請分析 @/sandbox/data/image/diet/2026-04-01/14-35-22.png 這張食物圖片，列出所有看得到的食物名稱、估計份量，以及每樣食物的營養成分（熱量kcal、蛋白質g、碳水化合物g、脂肪g）。請用繁體中文以條列方式回答。"
```

Claude will print the result to stdout and exit. Capture the output and use it as the nutritional analysis.

## Step 2: Record the result

After getting the analysis, record it in the agent's memory or workspace under the appropriate date section.

Format to use:

```markdown
## [DATE] 飲食紀錄

### [TIME]
圖片路徑：IMAGE_PATH

[claude 回傳的營養分析內容]
```

## Notes

- The `-p` flag runs claude in non-interactive print mode — it processes the prompt and exits immediately, no user input needed.
- The `@IMAGE_PATH` syntax tells claude to read and include the file as part of the prompt context.
- If claude is not on PATH, use the full path: `/sandbox/.local/bin/claude`.
- Claude uses your subscription quota, not Anthropic API billing.
