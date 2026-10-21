import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

categories = ['Housing', 'Food & Drink', 'Transport', 'Recreation', 'Clothing', 'Other']
shares_1995 = [22.0, 28.5, 16.0, 12.5, 11.0, 10.0]
shares_2020 = [34.0, 15.5, 21.0, 14.5, 5.0, 10.0]

colors = ['#2b5c8f', '#e67e22', '#27ae60', '#9b59b6', '#e74c3c', '#95a5a6']

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10, 5), dpi=150)

# 1995 Pie Chart
wedges1, texts1, autotexts1 = ax1.pie(
    shares_1995,
    labels=None,
    autopct='%1.1f%%',
    startangle=140,
    colors=colors,
    pctdistance=0.75,
    wedgeprops=dict(edgecolor='white', linewidth=1.5)
)
ax1.set_title('1995', fontsize=13, fontweight='bold', pad=10)

# 2020 Pie Chart
wedges2, texts2, autotexts2 = ax2.pie(
    shares_2020,
    labels=None,
    autopct='%1.1f%%',
    startangle=140,
    colors=colors,
    pctdistance=0.75,
    wedgeprops=dict(edgecolor='white', linewidth=1.5)
)
ax2.set_title('2020', fontsize=13, fontweight='bold', pad=10)

for autotext in autotexts1 + autotexts2:
    autotext.set_fontsize(9)
    autotext.set_fontweight('bold')
    autotext.set_color('white')

fig.suptitle('Proportion of Average Household Expenditure by Category in a Developed Nation',
             fontsize=12, fontweight='bold', y=0.98)

fig.legend(wedges1, categories, loc='lower center', ncol=3, bbox_to_anchor=(0.5, 0.02),
           fontsize=10, frameon=True)

plt.tight_layout()
plt.subplots_adjust(bottom=0.18, top=0.88)
plt.savefig('section_3_20261012/Task1/images/chart.png', bbox_inches='tight')
print("Pie charts generated successfully.")

