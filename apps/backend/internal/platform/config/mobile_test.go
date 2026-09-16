package config

import "testing"

func TestLoadMobileReleaseDefaults(t *testing.T) {
	p, err := LoadMobileRelease(func(string) (string, bool) { return "", false })
	if err != nil {
		t.Fatal(err)
	}
	if p.Platform != "android" || p.Channel != "internal" || p.Latest.AppVersion != "0.1.0" || p.Minimum.VersionCode != 1 {
		t.Fatalf("defaults = %#v", p)
	}
	if p.APKURL != nil {
		t.Fatal("default APK URL must be nil")
	}
}

func TestLoadMobileReleaseRejectsInvalidPolicy(t *testing.T) {
	cases := []map[string]string{
		{"DUALLANE_MOBILE_LATEST_VERSION": "1"},
		{"DUALLANE_MOBILE_MIN_VERSION": "2.0.0", "DUALLANE_MOBILE_LATEST_VERSION": "1.0.0"},
		{"DUALLANE_MOBILE_RECOMMENDATION": "forced"},
		{"DUALLANE_MOBILE_APK_URL": "http://example.test/app.apk"},
		{"DUALLANE_MOBILE_MIN_CODE": "2", "DUALLANE_MOBILE_APK_URL": "https://example.test/app.apk"},
	}
	for i, values := range cases {
		_, err := LoadMobileRelease(configLookup(values))
		if err == nil {
			t.Fatalf("case %d accepted invalid policy", i)
		}
	}
}

func TestLoadMobileReleaseAcceptsConfiguredUpdate(t *testing.T) {
	p, err := LoadMobileRelease(configLookup(map[string]string{
		"DUALLANE_MOBILE_LATEST_VERSION": "0.2.0",
		"DUALLANE_MOBILE_LATEST_CODE":    "2",
		"DUALLANE_MOBILE_MIN_VERSION":    "0.1.0",
		"DUALLANE_MOBILE_MIN_CODE":       "1",
		"DUALLANE_MOBILE_RECOMMENDATION": "strong",
		"DUALLANE_MOBILE_APK_URL":        "https://downloads.example.test/duallane.apk",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if p.Latest.ReleaseID != "android-0.2.0-2" || p.APKURL == nil || *p.APKURL != "https://downloads.example.test/duallane.apk" {
		t.Fatalf("policy = %#v", p)
	}
}
