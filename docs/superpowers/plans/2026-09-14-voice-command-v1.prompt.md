你在 Windows 上工作，工作目录是 `D:\Mineradio\resources\app\`（Mineradio 桌面版正在运行的明文源码，没有 asar，也不是 git 仓库）。

任务：严格按这份实施计划做完 Task 1 到 Task 5：
`C:\dev\Mineradio\docs\superpowers\plans\2026-09-14-voice-command-v1.md`

先把计划从头到尾读完再动手。计划里的「0. 背景事实」已经核对过源码并实测过，所有代码块和「查找 → 替换」锚点都已在源码副本上跑通过测试，不用重新调研，也不要换实现方案（比如把识别挪到渲染层、改用 npm 包）。

开始前先确认：`%APPDATA%\Mineradio\voice-model\` 里已有 `sherpa-onnx-wasm-main-vad-asr.data`（Task 0，由我手工下载）。没有就停下来告诉我，不要自己下载。

硬规矩：
1. 只动计划「文件结构」表里的 15 个文件（新建 9 个、修改 6 个）。其他文件一个字都别碰，包括格式化、注释、顺手优化。Task 2 Step 8 的 TTS 脚本和音频放 `%TEMP%\mineradio-voice-smoke\`，不进工作目录。
2. 代码块照抄。「查找」文本在文件里必须恰好出现一次；找不到、出现多次、或实际源码和计划描述对不上时，停下来报告差异，不要自己发挥。
3. 每个 Task 按步骤来：先写测试、跑一遍确认失败、再实现、再跑确认通过。命令都在 `D:\Mineradio\resources\app\` 下执行。
4. 不要 npm install，不要加任何依赖，不要改 Electron 启动参数或权限以外的安全设置。
5. 不要 git commit，不要改 `C:\dev\Mineradio` 里的任何文件。
6. Task 5 Step 2 要重启 Mineradio：先让我手动从托盘退出再启动，等我说「重启好了」再做 Step 3。Step 5 要我对着麦克风说话，你告诉我怎么做、等我回报结果。
7. Task 6 由我手工做，你不用做。

做完后按计划最后「完成后交回给 Claude 的东西」给我：
1. 改动文件列表。
2. Task 2 Step 9、Task 3 Step 10、Task 5 Step 1 的完整终端输出。
3. Task 5 Step 3–5 的实际返回。
