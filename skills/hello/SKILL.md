---
name: hello
description: Test skill that greets its argument. Use only when the user invokes it by name, such as /waffle:hello world.
---

# Hello

Reply with exactly one line, `hello <arg>!`, where `<arg>` is the argument text the user gave with the skill: $ARGUMENTS

- Print the argument as given, without changing its case or adding quotes.
- With no argument, reply `hello world!`.
- Add nothing else: no explanation, no code block, no tool calls.
