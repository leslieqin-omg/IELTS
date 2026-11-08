"""
test_morandi_wcag_stress.py - Empirical Challenger Stress Test for Morandi UI & WCAG Contrast.
Tests WCAG 2.1 AA/AAA compliance, token resolution, and absence of legacy vibrant hexes.
"""
import unittest
import os
import re

def parse_hex_color(hex_str):
    hex_str = hex_str.strip().lstrip('#')
    if len(hex_str) == 3:
        hex_str = ''.join(c * 2 for c in hex_str)
    r = int(hex_str[0:2], 16) / 255.0
    g = int(hex_str[2:4], 16) / 255.0
    b = int(hex_str[4:6], 16) / 255.0
    return r, g, b

def srgb_to_linear(c):
    if c <= 0.04045:
        return c / 12.92
    else:
        return ((c + 0.055) / 1.055) ** 2.4

def relative_luminance(r, g, b):
    R = srgb_to_linear(r)
    G = srgb_to_linear(g)
    B = srgb_to_linear(b)
    return 0.2126 * R + 0.7152 * G + 0.0722 * B

def contrast_ratio(hex1, hex2):
    r1, g1, b1 = parse_hex_color(hex1)
    r2, g2, b2 = parse_hex_color(hex2)
    l1 = relative_luminance(r1, g1, b1)
    l2 = relative_luminance(r2, g2, b2)
    lighter = max(l1, l2)
    darker = min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)

def composite_rgba_on_hex(rgba_str, bg_hex):
    m = re.match(r'rgba\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d\.]+)\s*\)', rgba_str.strip())
    if not m:
        raise ValueError(f"Cannot parse rgba: {rgba_str}")
    fg_r = int(m.group(1)) / 255.0
    fg_g = int(m.group(2)) / 255.0
    fg_b = int(m.group(3)) / 255.0
    a = float(m.group(4))
    
    bg_r, bg_g, bg_b = parse_hex_color(bg_hex)
    comp_r = fg_r * a + bg_r * (1.0 - a)
    comp_g = fg_g * a + bg_g * (1.0 - a)
    comp_b = fg_b * a + bg_b * (1.0 - a)
    
    hex_res = f"#{int(round(comp_r * 255)):02x}{int(round(comp_g * 255)):02x}{int(round(comp_b * 255)):02x}"
    return hex_res

class TestMorandiWCAGContrast(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cls.html_path = os.path.join(base_dir, "static", "index.html")
        cls.css_path = os.path.join(base_dir, "static", "css", "app.css")
        with open(cls.html_path, "r", encoding="utf-8") as f:
            cls.html_content = f.read()
        with open(cls.css_path, "r", encoding="utf-8") as f:
            cls.css_content = f.read()

    def test_01_body_text_contrast_light_mode(self):
        """Light mode: text vs card surface must meet WCAG AAA (>= 7.0:1) or AA (>= 4.5:1)."""
        card_bg = "#FAF8F5"
        text = "#2C3333"
        cr = contrast_ratio(text, card_bg)
        self.assertGreaterEqual(cr, 7.0, f"Body text in light mode should be >= 7.0:1 (AAA), got {cr:.2f}:1")

    def test_02_body_text_contrast_dark_mode(self):
        """Dark mode: text vs card surface must meet WCAG AAA (>= 7.0:1) or AA (>= 4.5:1)."""
        card_bg = "#272C2E"
        text = "#E5E1D8"
        cr = contrast_ratio(text, card_bg)
        self.assertGreaterEqual(cr, 7.0, f"Body text in dark mode should be >= 7.0:1 (AAA), got {cr:.2f}:1")

    def test_03_dark_mode_button_contrast(self):
        """Dark mode buttons: Deep Basalt #1E2224 text on pastel backgrounds must meet AA/AAA (>= 4.5:1)."""
        btn_text = "#1E2224"
        pastels = {
            "Sage Primary": "#84A492",
            "Sage Hover": "#98B8A6",
            "Heather Lilac": "#B3A9D4",
            "Muted Jade Success": "#78AD91",
            "Terracotta Error": "#D87A72",
            "Amber Sand Warning": "#D19E5B"
        }
        for name, bg in pastels.items():
            cr = contrast_ratio(btn_text, bg)
            self.assertGreaterEqual(cr, 4.5, f"Dark mode button {name} ({bg}) contrast must be >= 4.5:1, got {cr:.2f}:1")

    def test_04_light_mode_badge_phrase_contrast(self):
        """Light mode phrase badge: var(--warning) on var(--warning-bg) composited on card surface."""
        comp_bg = composite_rgba_on_hex("rgba(156, 106, 46, 0.12)", "#FAF8F5")
        cr = contrast_ratio("#9C6A2E", comp_bg)
        self.assertGreaterEqual(cr, 3.0, f"Badge phrase contrast must meet WCAG UI/Large text >= 3.0:1, got {cr:.2f}:1")

    def test_05_legacy_vibrant_colors_absent_in_js(self):
        """Verify no hardcoded legacy vibrant hex codes in index.html scripts."""
        forbidden_patterns = [
            (r'style\.color\s*=\s*[\'"]#059669[\'"]', "Hardcoded vibrant emerald green in JS style"),
            (r'style\.color\s*=\s*[\'"]#10b981[\'"]', "Hardcoded vibrant green in JS style"),
            (r'style\.color\s*=\s*[\'"]#f59e0b[\'"]', "Hardcoded vibrant amber in JS style"),
            (r'style\.color\s*=\s*[\'"]#d97706[\'"]', "Hardcoded vibrant dark amber in JS style"),
            (r'linear-gradient\([^)]*#10b981[^)]*\)', "Legacy green linear gradient"),
            (r'linear-gradient\([^)]*#f59e0b[^)]*\)', "Legacy amber linear gradient"),
        ]
        for pattern, desc in forbidden_patterns:
            matches = re.findall(pattern, self.html_content)
            self.assertEqual(len(matches), 0, f"Found forbidden pattern: {desc} (count: {len(matches)})")

    def test_06_css_variables_symmetry_and_resolution(self):
        """Verify that all CSS custom properties in :root / dark mode have light mode equivalents and vice-versa."""
        def extract_vars(block):
            return set(re.findall(r'(--[a-zA-Z0-9_-]+)\s*:', block))

        for filename, content in [("index.html", self.html_content), ("app.css", self.css_content)]:
            dark_matches = re.findall(r'(?::root\s*,\s*\[data-theme=["\']dark["\']\]|:root)[^{]*\{([^}]+)\}', content)
            light_matches = re.findall(r'\[data-theme=["\']light["\']\][^{]*\{([^}]+)\}', content)
            
            self.assertTrue(len(dark_matches) > 0, f"No dark theme block in {filename}")
            self.assertTrue(len(light_matches) > 0, f"No light theme block in {filename}")
            
            dark_vars = extract_vars(dark_matches[0])
            light_vars = extract_vars(light_matches[0])
            
            core_expected = {'--bg', '--card-bg', '--card-border', '--text', '--text-muted',
                             '--primary', '--primary-hover', '--btn-primary-text',
                             '--success', '--error', '--warning', '--accent'}
            
            self.assertTrue(core_expected.issubset(dark_vars), f"Missing core vars in dark mode of {filename}: {core_expected - dark_vars}")
            self.assertTrue(core_expected.issubset(light_vars), f"Missing core vars in light mode of {filename}: {core_expected - light_vars}")

    def test_07_all_color_contrast_pairs(self):
        """Verify comprehensive light and dark mode contrast pairs against WCAG 2.1 criteria."""
        # WCAG 2.1 AA: Body text >= 4.5:1; UI controls / buttons / large text >= 3.0:1
        light_pairs = [
            ("Body text on canvas", "#2C3333", "#F4F1EA", 4.5),
            ("Body text on card", "#2C3333", "#FAF8F5", 4.5),
            ("Body text on input", "#2C3333", "#EFECE5", 4.5),
            ("Muted text on canvas", "#5C6565", "#F4F1EA", 4.5),
            ("Muted text on card", "#5C6565", "#FAF8F5", 4.5),
            ("White on Primary button", "#ffffff", "#5C7367", 3.0),
            ("White on Primary-hover button", "#ffffff", "#495D53", 4.5),
            ("White on Success button", "#ffffff", "#5B8266", 3.0),
            ("White on Error button", "#ffffff", "#AB645B", 3.0),
            ("White on Warning button", "#ffffff", "#9C6A2E", 3.0),
            ("White on Accent button", "#ffffff", "#655C82", 4.5),
            ("Primary on card", "#5C7367", "#FAF8F5", 3.0),
            ("Success on card", "#5B8266", "#FAF8F5", 3.0),
            ("Error on card", "#AB645B", "#FAF8F5", 3.0),
            ("Warning on card", "#9C6A2E", "#FAF8F5", 3.0),
            ("Accent on card", "#655C82", "#FAF8F5", 3.0),
        ]
        for name, fg, bg, req in light_pairs:
            cr = contrast_ratio(fg, bg)
            self.assertGreaterEqual(cr, req, f"[Light Mode] {name} ({fg} on {bg}) failed contrast: {cr:.2f}:1 < {req:.1f}:1")

        dark_pairs = [
            ("Body text on canvas", "#E5E1D8", "#1E2224", 4.5),
            ("Body text on card", "#E5E1D8", "#272C2E", 4.5),
            ("Body text on input", "#E5E1D8", "#191C1E", 4.5),
            ("Muted text on card", "#9CA6A8", "#272C2E", 4.5),
            ("Basalt on Primary button", "#1E2224", "#84A492", 4.5),
            ("Basalt on Primary-hover button", "#1E2224", "#98B8A6", 4.5),
            ("Basalt on Success button", "#1E2224", "#78AD91", 4.5),
            ("Basalt on Error button", "#1E2224", "#D87A72", 4.5),
            ("Basalt on Warning button", "#1E2224", "#D19E5B", 4.5),
            ("Basalt on Accent button", "#1E2224", "#B3A9D4", 4.5),
            ("Primary on card", "#84A492", "#272C2E", 3.0),
            ("Success on card", "#78AD91", "#272C2E", 3.0),
            ("Error on card", "#D87A72", "#272C2E", 3.0),
            ("Warning on card", "#D19E5B", "#272C2E", 3.0),
            ("Accent on card", "#B3A9D4", "#272C2E", 3.0),
        ]
        for name, fg, bg, req in dark_pairs:
            cr = contrast_ratio(fg, bg)
            self.assertGreaterEqual(cr, req, f"[Dark Mode] {name} ({fg} on {bg}) failed contrast: {cr:.2f}:1 < {req:.1f}:1")

    def test_08_audio_wave_bar_current_color(self):
        """Verify .audio-wave-bar uses currentColor to dynamically match button text."""
        self.assertIn(".audio-wave-bar", self.html_content)
        pattern = r'\.audio-wave-bar\s*\{[^}]*background:\s*currentColor;'
        self.assertTrue(re.search(pattern, self.html_content), ".audio-wave-bar must use background: currentColor;")

    def test_09_dark_mode_button_override_selectors(self):
        """Verify dark mode overrides set color: #1E2224 !important for buttons."""
        dark_override = re.search(r'\[data-theme=["\']dark["\']\]\s*\.btn-start[^}]*color:\s*#1E2224\s*!important;', self.html_content)
        self.assertIsNotNone(dark_override, "Missing dark mode button text #1E2224 !important override in index.html")

    def test_10_spot_check_and_pretest_ui_badges(self):
        """Verify spot check and pretest badge tokens."""
        self.assertIn(".badge-tag.badge-spot-check", self.html_content)
        self.assertIn(".spot-check-hint-box", self.html_content)
        self.assertIn(".badge-tag.badge-pretest", self.html_content)
        self.assertIn(".summary-pretest-grid", self.html_content)

    def test_11_zero_unresolved_css_variables(self):
        """Audit that all var(--xxx) usages are defined in both dark and light modes."""
        for filename, content in [("index.html", self.html_content), ("app.css", self.css_content)]:
            dark_blocks = re.findall(r"(?::root\s*,\s*\[data-theme=[\x27\"]dark[\x27\"]\]|:root)[^{]*\{([^}]+)\}", content)
            light_blocks = re.findall(r"\[data-theme=[\x27\"]light[\x27\"]\][^{]*\{([^}]+)\}", content)
            
            dark_vars = set()
            for b in dark_blocks:
                dark_vars.update(re.findall(r"(--[a-zA-Z0-9_-]+)\s*:", b))
            light_vars = set()
            for b in light_blocks:
                light_vars.update(re.findall(r"(--[a-zA-Z0-9_-]+)\s*:", b))
                
            used_vars = set(re.findall(r"var\(\s*(--[a-zA-Z0-9_-]+)", content))
            
            missing_dark = used_vars - dark_vars
            missing_light = used_vars - light_vars
            self.assertEqual(len(missing_dark), 0, f"{filename} has undefined variables in dark mode: {missing_dark}")
            self.assertEqual(len(missing_light), 0, f"{filename} has undefined variables in light mode: {missing_light}")

if __name__ == '__main__':
    unittest.main()
