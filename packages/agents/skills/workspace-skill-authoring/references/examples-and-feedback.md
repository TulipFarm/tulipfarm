# Examples and feedback

Suggest two or three prompts that resemble the person's real task: a usual case, a boundary case, and a case where this skill should not apply. State observable expected outputs and constraints. Label proposed examples as not run.

Run tests only when the person requests them. Use synthetic or explicitly authorized sample data. A package must pass human review before its scripts can run. Tests do not approve business writes or permit external calls. Use skills.execute only with the exact reviewed revision and entrypoint. If pending or uncertain, check the same invocationId and arguments; never create a new invocation merely to retry.

Compare the observed result with the stated expectation. Report failures, unsupported dependencies, unavailable runtime, and untested assumptions plainly. Ask for feedback on the result rather than claiming a score without evidence.

Make a targeted patch and prepare another human review. Keep successful unrelated behavior and resources. Do not launch automatic paid benchmark, prompt optimization, or repeated model evaluation loops.
