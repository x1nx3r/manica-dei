BINARY := cdn
PORT ?= 8891

.PHONY: build run test vet fmt smoke clean

build:
	go build -o bin/$(BINARY) ./cmd/server

run:
	go run ./cmd/server

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -l -w .

smoke:
	bash scripts/smoke.sh

clean:
	rm -rf bin
