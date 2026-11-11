package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type NewsItem struct {
	Title  string   `json:"title"`
	Desc   string   `json:"desc"`
	Source string   `json:"source"`
	URL    string   `json:"url"`
	Tags   []string `json:"tags"`
	Reason string   `json:"reason"`
	Score  int      `json:"score"`
}

type NewsPayload struct {
	UpdatedAt string     `json:"updatedAt"`
	Items     []NewsItem `json:"items"`
}

type APIResponse struct {
	OK        bool       `json:"ok"`
	UpdatedAt string     `json:"updatedAt"`
	Count     int        `json:"count"`
	Items     []NewsItem `json:"items"`
	Error     string     `json:"error,omitempty"`
}

var allowedTags = map[string]struct{}{
	"Agent": {}, "产品更新": {}, "大模型": {}, "具身智能": {},
	"开源": {}, "研究": {}, "工具": {}, "搜索": {},
}

type store struct {
	mu      sync.RWMutex
	payload NewsPayload
	path    string
}

func (s *store) load() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}
	var payload NewsPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return err
	}
	payload.Items = normalizeList(payload.Items)
	if payload.UpdatedAt == "" {
		payload.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	s.mu.Lock()
	s.payload = payload
	s.mu.Unlock()
	return nil
}

func (s *store) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s.payload, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func normalizeItem(item NewsItem) (NewsItem, bool) {
	item.Title = strings.TrimSpace(item.Title)
	if item.Title == "" {
		return NewsItem{}, false
	}
	item.Desc = strings.TrimSpace(item.Desc)
	item.Source = strings.TrimSpace(item.Source)
	if item.Source == "" {
		item.Source = "AI资讯"
	}
	item.URL = strings.TrimSpace(item.URL)
	item.Reason = strings.TrimSpace(item.Reason)
	tags := make([]string, 0, len(item.Tags))
	seen := map[string]struct{}{}
	for _, tag := range item.Tags {
		if _, ok := allowedTags[tag]; !ok {
			continue
		}
		if _, dup := seen[tag]; dup {
			continue
		}
		seen[tag] = struct{}{}
		tags = append(tags, tag)
	}
	item.Tags = tags
	if item.Score < 60 || item.Score > 99 {
		item.Score = 72
	}
	return item, true
}

func normalizeList(items []NewsItem) []NewsItem {
	out := make([]NewsItem, 0, len(items))
	for _, item := range items {
		if n, ok := normalizeItem(item); ok {
			out = append(out, n)
		}
	}
	return out
}

func decodeItems(r io.Reader) ([]NewsItem, error) {
	raw, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	var list []NewsItem
	if err := json.Unmarshal(raw, &list); err == nil {
		return normalizeList(list), nil
	}
	var payload NewsPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("invalid json: expect array or {items:[]}")
	}
	return normalizeList(payload.Items), nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *store) getNews(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, APIResponse{OK: false, Error: "method not allowed"})
		return
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	writeJSON(w, http.StatusOK, APIResponse{
		OK:        true,
		UpdatedAt: s.payload.UpdatedAt,
		Count:     len(s.payload.Items),
		Items:     s.payload.Items,
	})
}

func (s *store) putNews(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, APIResponse{OK: false, Error: "method not allowed"})
		return
	}
	items, err := decodeItems(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, APIResponse{OK: false, Error: err.Error()})
		return
	}
	if len(items) == 0 {
		writeJSON(w, http.StatusBadRequest, APIResponse{OK: false, Error: "news list is empty"})
		return
	}
	s.mu.Lock()
	s.payload.Items = items
	s.payload.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	err = s.saveLocked()
	payload := s.payload
	s.mu.Unlock()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, APIResponse{OK: false, Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, APIResponse{
		OK:        true,
		UpdatedAt: payload.UpdatedAt,
		Count:     len(payload.Items),
		Items:     payload.Items,
	})
}

func (s *store) health(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	count := len(s.payload.Items)
	s.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "count": count})
}

func hasNewsOrWeb(root string) bool {
	if _, err := os.Stat(filepath.Join(root, "data", "news.json")); err == nil {
		return true
	}
	if _, err := os.Stat(filepath.Join(root, "web", "index.html")); err == nil {
		return true
	}
	if _, err := os.Stat(filepath.Join(root, "index.html")); err == nil {
		return true
	}
	return false
}

func resolveRoot() string {
	var candidates []string
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates, dir)
		if filepath.Base(dir) == "bin" {
			candidates = append(candidates, filepath.Dir(dir))
		}
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, wd)
	}
	for _, root := range candidates {
		if hasNewsOrWeb(root) {
			return root
		}
	}
	if wd, err := os.Getwd(); err == nil {
		return wd
	}
	return "."
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

func main() {
	port := flag.Int("port", 8787, "listen port")
	noOpen := flag.Bool("no-open", false, "do not open browser")
	flag.Parse()

	root := resolveRoot()
	webDir := filepath.Join(root, "web")
	dataPath := filepath.Join(root, "data", "news.json")
	if _, err := os.Stat(filepath.Join(webDir, "index.html")); err != nil {
		webDir = root
		dataPath = filepath.Join(root, "data", "news.json")
	}

	st := &store{path: dataPath}
	if err := st.load(); err != nil {
		log.Fatalf("load news.json failed: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", st.health)
	mux.HandleFunc("/api/news", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			st.getNews(w, r)
		case http.MethodPut, http.MethodPost:
			st.putNews(w, r)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, APIResponse{OK: false, Error: "method not allowed"})
		}
	})
	mux.Handle("/", http.FileServer(http.Dir(webDir)))

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen %s failed: %v", addr, err)
	}

	url := "http://" + addr + "/"
	log.Printf("AI Hot News running at %s", url)
	log.Printf("news file: %s", dataPath)
	if !*noOpen {
		go func() {
			time.Sleep(300 * time.Millisecond)
			openBrowser(url)
		}()
	}

	if err := http.Serve(ln, mux); err != nil {
		log.Fatal(err)
	}
}
