package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestResolveRootFindsNewsJSON(t *testing.T) {
	orig, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "data", "news.json"), []byte(`{"items":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(orig) })
	got := resolveRoot()
	if got != dir {
		t.Fatalf("resolveRoot=%s want=%s", got, dir)
	}
}

func TestNormalizeItem(t *testing.T) {
	item, ok := normalizeItem(NewsItem{
		Title:  "  Hello  ",
		Tags:   []string{"大模型", "bad", "大模型", "开源"},
		Score:  12,
		Source: "",
	})
	if !ok {
		t.Fatal("expected item")
	}
	if item.Title != "Hello" {
		t.Fatalf("title=%s", item.Title)
	}
	if item.Source != "AI资讯" {
		t.Fatalf("source=%s", item.Source)
	}
	if item.Score != 72 {
		t.Fatalf("score=%d", item.Score)
	}
	if len(item.Tags) != 2 || item.Tags[0] != "大模型" || item.Tags[1] != "开源" {
		t.Fatalf("tags=%v", item.Tags)
	}
	if _, ok := normalizeItem(NewsItem{Title: " "}); ok {
		t.Fatal("blank title should fail")
	}
}

func TestNewsAPI(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "news.json")
	seed := NewsPayload{UpdatedAt: "2026-01-01T00:00:00Z", Items: []NewsItem{{Title: "Seed", Tags: []string{"开源"}, Score: 80}}}
	raw, _ := json.Marshal(seed)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	st := &store{path: path}
	if err := st.load(); err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/news", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			st.getNews(w, r)
			return
		}
		st.putNews(w, r)
	})
	mux.HandleFunc("/api/health", st.health)

	req := httptest.NewRequest(http.MethodGet, "/api/news", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("get status=%d", rec.Code)
	}
	var got APIResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.OK || got.Count != 1 || got.Items[0].Title != "Seed" {
		t.Fatalf("get body=%s", rec.Body.String())
	}

	body := bytes.NewBufferString(`[{"title":"New Item","tags":["Agent"],"score":90}]`)
	req = httptest.NewRequest(http.MethodPut, "/api/news", body)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("put status=%d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("health status=%d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPut, "/api/news", bytes.NewBufferString(`[]`))
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Fatalf("empty put status=%d", rec.Code)
	}
}
