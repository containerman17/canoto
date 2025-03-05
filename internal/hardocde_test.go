package examples

import (
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	_ "embed"

	"github.com/stretchr/testify/require"
)

//go:embed testdata/scalars.json
var scalarsJSON []byte

//go:embed testdata/scalars.hex
var scalarsHex string

func TestHardcodeScalars(t *testing.T) {
	scalars := &Scalars{}

	err := json.Unmarshal(scalarsJSON, scalars)
	require.NoError(t, err)

	scalarsBytes := scalars.MarshalCanoto()
	require.Equal(t, strings.TrimSpace(scalarsHex), hex.EncodeToString(scalarsBytes))
}
