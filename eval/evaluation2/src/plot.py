#!/usr/bin/env python3
"""Recreate the final comparison figure from data/analysis.json."""

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


ROOT = Path(__file__).resolve().parent.parent
DATA = json.loads((ROOT / "data" / "analysis.json").read_text())
OUTPUT = ROOT / "results.png"
TASK_LABELS = {"simple": "Simple", "normal": "Normal", "hard": "Hard"}
ARMS = [
    ("plain_note", "Plain", "#777777", ""),
    ("plain_note_clear", "Plain + clear", "#BBBBBB", "//"),
    ("steps_note", "Steps", "#2369A8", ""),
    ("steps_note_clear", "Steps + clear", "#8DB9DE", "//"),
]


def main():
    tasks = DATA["tasks"]
    x = np.arange(len(tasks))
    width = 0.19
    fig, ax = plt.subplots(figsize=(10, 5.8), dpi=160)

    for index, (arm, label, color, hatch) in enumerate(ARMS):
        values = np.array([task["byArm"][arm]["meanFinalHidden"] * 100 for task in tasks])
        intervals = [task["byArm"][arm]["meanFinalHiddenBootstrap95"] for task in tasks]
        lower = values - np.array([interval[0] * 100 for interval in intervals])
        upper = np.array([interval[1] * 100 for interval in intervals]) - values
        bars = ax.bar(
            x + (index - 1.5) * width,
            values,
            width,
            label=label,
            color=color,
            hatch=hatch,
            edgecolor="#24313D",
            linewidth=0.7,
            yerr=np.vstack([lower, upper]),
            capsize=3,
            error_kw={"elinewidth": 1, "ecolor": "#24313D"},
        )
        ax.bar_label(bars, labels=[f"{value:.1f}" for value in values], padding=3, fontsize=8)

    fig.suptitle(
        "Final hidden-test accuracy across task difficulty",
        x=0.09, y=0.975, ha="left", fontsize=14, weight="bold",
    )
    fig.text(
        0.09, 0.925,
        "GPT-4o mini; n=25 per arm per task; error bars are 95% independent-session bootstrap intervals",
        fontsize=9, color="#4F5B66",
    )
    ax.set_ylabel("Hidden-test accuracy (%)")
    ax.set_xticks(x, [TASK_LABELS[task["task"]] for task in tasks])
    ax.set_ylim(0, 108)
    ax.grid(axis="y", color="#DDE2E6", linewidth=0.8)
    ax.set_axisbelow(True)
    ax.spines[["top", "right"]].set_visible(False)
    ax.legend(ncol=4, loc="upper center", bbox_to_anchor=(0.5, -0.11), frameon=False)
    fig.subplots_adjust(bottom=0.19, top=0.86, left=0.09, right=0.98)
    fig.savefig(OUTPUT, bbox_inches="tight", facecolor="white")
    print(OUTPUT)


if __name__ == "__main__":
    main()
