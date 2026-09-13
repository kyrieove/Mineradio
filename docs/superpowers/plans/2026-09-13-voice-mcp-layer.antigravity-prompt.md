你在 Windows 上工作，工作目录是 `D:\Mineradio\resources\app\`（Mineradio 桌面版正在运行的明文源码，没有 asar，也不是 git 仓库）。

任务：严格按这份实施计划做完 Task 1 到 Task 6：
`C:\dev\Mineradio\docs\superpowers\plans\2026-09-13-voice-mcp-layer.md`

先把计划从头到尾读完再动手。计划里的「0. 背景事实」已经核对过源码，函数名、行号、全局变量都能直接用，不用重新调研。

硬规矩：
1. 只改计划「文件结构」表里的 8 个文件（新建 4 个、修改 4 个）。其他文件一个字都别碰，包括格式化、注释、顺手优化。
2. 代码块照抄。实际源码和计划描述对不上（函数不存在、签名不同、插入点那行找不到）时，停下来报告差异，不要自己发挥。
3. 每个 Task 按步骤来：先写测试、跑一遍确认失败、再实现、再跑确认通过。命令都在 `D:\Mineradio\resources\app\` 下执行。
4. 不要 npm install，不要加任何依赖。
5. 不要 git commit，不要改 `C:\dev\Mineradio` 里的代码（计划文件除外，也不用改它）。
6. Task 6 Step 2 要重启 Mineradio：先让我手动从托盘退出再启动，等我说「重启好了」再跑 Step 3 的 PowerShell 冒烟。
7. Task 7 由我手工做，你不用做。

做完后按计划最后「完成后交回给 Claude 的东西」给我：
1. 改动文件列表。
2. Task 6 Step 1 的完整终端输出。
3. Task 6 Step 3 冒烟每一条的实际返回。
