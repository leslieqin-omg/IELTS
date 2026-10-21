import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

# Data
faculties = [
    "Computer Science",
    "Engineering",
    "Law",
    "Medicine",
    "Humanities",
    "Education"
]

male_percentages = [72.4, 68.1, 46.5, 41.8, 31.2, 24.6]
female_percentages = [27.6, 31.9, 53.5, 58.2, 68.8, 75.4]

x = np.arange(len(faculties))
width = 0.35

fig, ax = plt.subplots(figsize=(8, 5), dpi=150)

rects1 = ax.bar(x - width/2, male_percentages, width, label='Male', color='#336699', edgecolor='black', linewidth=0.8, hatch='//')
rects2 = ax.bar(x + width/2, female_percentages, width, label='Female', color='#D95F02', edgecolor='black', linewidth=0.8, hatch='..')

ax.set_ylabel('Percentage of Enrolled Students (%)', fontsize=11, fontweight='medium')
ax.set_title('Gender Distribution Across University Faculties in a European Country (2022)', fontsize=12, fontweight='bold', pad=15)
ax.set_xticks(x)
ax.set_xticklabels(faculties, rotation=20, ha='right', fontsize=10)
ax.set_ylim(0, 100)
ax.grid(axis='y', linestyle='--', alpha=0.5)
ax.legend(frameon=True, loc='upper right', fontsize=10)

# Value labels on top of bars
for rect in rects1:
    height = rect.get_height()
    ax.annotate(f'{height:.1f}%',
                xy=(rect.get_x() + rect.get_width() / 2, height),
                xytext=(0, 3),  # 3 points vertical offset
                textcoords="offset points",
                ha='center', va='bottom', fontsize=8)

for rect in rects2:
    height = rect.get_height()
    ax.annotate(f'{height:.1f}%',
                xy=(rect.get_x() + rect.get_width() / 2, height),
                xytext=(0, 3),
                textcoords="offset points",
                ha='center', va='bottom', fontsize=8)

plt.tight_layout()
plt.savefig('IELTS_Practice/images/IELTS_20261002_Task1_01_chart.png', bbox_inches='tight')
print("Chart generated successfully.")

