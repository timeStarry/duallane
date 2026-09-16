package config

import (
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type MobileReleaseVersion struct {
	AppVersion  string `json:"appVersion"`
	VersionCode int    `json:"versionCode"`
}
type MobileLatest struct {
	MobileReleaseVersion
	ReleaseID    string   `json:"releaseId"`
	ReleaseNotes []string `json:"releaseNotes"`
}
type MobileProtocol struct {
	EventMajor     int      `json:"eventMajor"`
	ContentFormats []string `json:"contentFormats"`
}
type MobileReleasePolicy struct {
	SchemaVersion  int                  `json:"schemaVersion"`
	Platform       string               `json:"platform"`
	Channel        string               `json:"channel"`
	Latest         MobileLatest         `json:"latest"`
	Minimum        MobileReleaseVersion `json:"minimum"`
	Recommendation string               `json:"recommendation"`
	APKURL         *string              `json:"apkUrl"`
	Protocol       MobileProtocol       `json:"protocol"`
}

func LoadMobileRelease(lookup func(string) (string, bool)) (MobileReleasePolicy, error) {
	p := MobileReleasePolicy{SchemaVersion: 1, Platform: "android", Channel: "internal", Latest: MobileLatest{MobileReleaseVersion: MobileReleaseVersion{"0.1.0", 1}, ReleaseID: "android-0.1.0-1", ReleaseNotes: []string{}}, Minimum: MobileReleaseVersion{"0.1.0", 1}, Recommendation: "none", Protocol: MobileProtocol{1, []string{"duallane.message+json;v=1"}}}
	p.Latest.AppVersion = valueOr(lookup, "DUALLANE_MOBILE_LATEST_VERSION", "0.1.0")
	p.Minimum.AppVersion = valueOr(lookup, "DUALLANE_MOBILE_MIN_VERSION", "0.1.0")
	version := regexp.MustCompile(`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$`)
	if !version.MatchString(p.Latest.AppVersion) || !version.MatchString(p.Minimum.AppVersion) {
		return p, errors.New("mobile version must be major.minor.patch")
	}
	for key, target := range map[string]*int{"DUALLANE_MOBILE_LATEST_CODE": &p.Latest.VersionCode, "DUALLANE_MOBILE_MIN_CODE": &p.Minimum.VersionCode} {
		v, err := strconv.Atoi(valueOr(lookup, key, "1"))
		if err != nil || v < 1 || v > 2100000000 {
			return p, errors.New("mobile version code is invalid")
		}
		*target = v
	}
	if mobileCompare(p.Minimum.AppVersion, p.Latest.AppVersion) > 0 || p.Minimum.VersionCode > p.Latest.VersionCode {
		return p, errors.New("mobile minimum exceeds latest")
	}
	p.Recommendation = valueOr(lookup, "DUALLANE_MOBILE_RECOMMENDATION", "none")
	if p.Recommendation != "none" && p.Recommendation != "soft" && p.Recommendation != "strong" {
		return p, errors.New("mobile recommendation is invalid")
	}
	if raw := valueOr(lookup, "DUALLANE_MOBILE_APK_URL", ""); raw != "" {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return p, errors.New("mobile APK URL must be public HTTPS without credentials")
		}
		p.APKURL = &raw
	}
	if (p.Recommendation != "none" || mobileCompare(p.Minimum.AppVersion, "0.1.0") > 0 || p.Minimum.VersionCode > 1) && p.APKURL == nil {
		return p, errors.New("mobile update requires reachable APK URL configuration")
	}
	p.Latest.ReleaseID = "android-" + p.Latest.AppVersion + "-" + strconv.Itoa(p.Latest.VersionCode)
	return p, nil
}
func mobileCompare(a, b string) int {
	aa, bb := strings.Split(a, "."), strings.Split(b, ".")
	for i := range aa {
		x, _ := strconv.ParseUint(aa[i], 10, 64)
		y, _ := strconv.ParseUint(bb[i], 10, 64)
		if x > y {
			return 1
		}
		if x < y {
			return -1
		}
	}
	return 0
}
