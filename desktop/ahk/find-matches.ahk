#Requires AutoHotkey v2.0
#SingleInstance Force

if (A_Args.Length < 2) {
  ExitApp 1
}

inputPath := A_Args[1]
outputPath := A_Args[2]

lines := StrSplit(FileRead(inputPath, "UTF-8"), "`n", "`r")
matches := []

boundsParts := StrSplit(lines[1], "|")
left := boundsParts[2] + 0
top := boundsParts[3] + 0
right := boundsParts[4] + 0
bottom := boundsParts[5] + 0
tileSize := boundsParts[6] + 0
tileOverlap := boundsParts[7] + 0
dedupeDistance := boundsParts[8] + 0
tileStep := Max(8, tileSize - tileOverlap)

for index, line in lines {
  if (index = 1 || !Trim(line)) {
    continue
  }

  parts := StrSplit(line, "|")

  if (parts.Length < 6) {
    continue
  }

  itemId := parts[1]
  imagePath := parts[2]
  slotSize := parts[3] + 0
  maxMatches := parts[4] + 0
  variation := parts[5] + 0
  scale := parts[6]

  itemMatches := []

  y := top
  while (y <= bottom && itemMatches.Length < maxMatches) {
    x := left

    while (x <= right && itemMatches.Length < maxMatches) {
      searchRight := Min(x + tileSize, right)
      searchBottom := Min(y + tileSize, bottom)
      searchImage := "*" variation " " imagePath

      try {
        foundX := 0
        foundY := 0
        if ImageSearch(&foundX, &foundY, x, y, searchRight, searchBottom, searchImage) {
          if !HasNearbyMatch(itemMatches, foundX, foundY, dedupeDistance) {
            itemMatches.Push(Map(
              "itemId", itemId,
              "x", foundX,
              "y", foundY,
              "slotSize", slotSize,
              "scale", scale
            ))
          }
        }
      }

      x += tileStep
    }

    y += tileStep
  }

  for _, match in itemMatches {
    matches.Push(match)
  }
}

outputLines := ["provider|ahk"]

for _, match in matches {
  outputLines.Push(
    match["itemId"] "|" match["x"] "|" match["y"] "|" match["slotSize"] "|" match["scale"]
  )
}

try FileDelete(outputPath)
FileAppend(StrJoin(outputLines, "`n"), outputPath, "UTF-8")
ExitApp 0

HasNearbyMatch(matches, x, y, dedupeDistance) {
  for _, match in matches {
    dx := match["x"] - x
    dy := match["y"] - y

    if Sqrt((dx * dx) + (dy * dy)) < dedupeDistance {
      return true
    }
  }

  return false
}

StrJoin(values, separator) {
  joined := ""

  for index, value in values {
    joined .= (index > 1 ? separator : "") value
  }

  return joined
}
