import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

years = [1980, 1990, 2000, 2010, 2020]

# Energy sources consumption in Million Tonnes of Oil Equivalent (Mtoe)
coal = [82.5, 78.1, 55.4, 38.2, 21.6]
natural_gas = [34.0, 48.5, 68.2, 79.5, 84.1]
nuclear = [12.4, 25.6, 31.8, 28.4, 22.1]
renewables = [4.2, 6.8, 14.5, 32.1, 62.4]

fig, ax = plt.subplots(figsize=(8, 5), dpi=150)

ax.plot(years, coal, label='Coal', color='#2b2b2b', linestyle='-', marker='o', linewidth=2.2, markersize=6)
ax.plot(years, natural_gas, label='Natural Gas', color='#1f77b4', linestyle='--', marker='s', linewidth=2.2, markersize=6)
ax.plot(years, nuclear, label='Nuclear Power', color='#9467bd', linestyle='-.', marker='^', linewidth=2.0, markersize=6)
ax.plot(years, renewables, label='Renewables (Wind/Solar/Hydro)', color='#2ca02c', linestyle=':', marker='D', linewidth=2.4, markersize=6)

ax.set_title('Energy Consumption by Fuel Source in a European Nation (1980–2020)', fontsize=12, fontweight='bold', pad=15)
ax.set_xlabel('Year', fontsize=11, fontweight='medium')
ax.set_ylabel('Consumption (Million Tonnes of Oil Equivalent)', fontsize=10, fontweight='medium')
ax.set_xticks(years)
ax.set_ylim(0, 100)
ax.grid(True, linestyle='--', alpha=0.5)
ax.legend(frameon=True, loc='center left', bbox_to_anchor=(0.02, 0.45), fontsize=9)

# Annotate endpoints for clarity
ax.annotate('84.1', xy=(2020, 84.1), xytext=(5, -2), textcoords='offset points', fontsize=8, color='#1f77b4', fontweight='bold')
ax.annotate('62.4', xy=(2020, 62.4), xytext=(5, -2), textcoords='offset points', fontsize=8, color='#2ca02c', fontweight='bold')
ax.annotate('21.6', xy=(2020, 21.6), xytext=(5, -2), textcoords='offset points', fontsize=8, color='#2b2b2b', fontweight='bold')
ax.annotate('22.1', xy=(2020, 22.1), xytext=(5, 4), textcoords='offset points', fontsize=8, color='#9467bd', fontweight='bold')

plt.tight_layout()
plt.savefig('section_2_20261008/Task1/images/chart.png', bbox_inches='tight')
print("Line graph generated successfully.")

