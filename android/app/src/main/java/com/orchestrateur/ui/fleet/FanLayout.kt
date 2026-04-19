package com.orchestrateur.ui.fleet

import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import com.orchestrateur.data.Musician
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

private fun apexFirstIndices(n: Int): IntArray {
    val out = IntArray(n)
    val mid = (n - 1) / 2
    out[0] = mid
    var wrote = 1
    var step = 1
    while (wrote < n) {
        val r = mid + step
        val l = mid - step
        if (r < n) out[wrote++] = r
        if (l >= 0 && wrote < n) out[wrote++] = l
        step++
    }
    return out
}

private const val CARDS_PER_HAND = 5
private const val CARD_HEIGHT_DP = 240f

data class PlacedCard(
    val musician: Musician,
    val xCenterPx: Float,
    val yBottomPx: Float,
    val widthPx: Float,
    val rotationDeg: Float,
    val z: Float,
    val hand: Int,
)

fun layoutFan(
    musicians: List<Musician>,
    deckOffset: Int,
    viewportW: Float,
    viewportH: Float,
): List<PlacedCard> {
    val n = musicians.size
    if (n == 0) return emptyList()
    val rot = deckOffset % n
    val deck = List(n) { musicians[(it + rot) % n] }

    val hands = deck.chunked(CARDS_PER_HAND)
    val handCount = hands.size

    val bottomPad = 200f
    val topPad = 72f
    val usableH = viewportH - topPad - bottomPad
    val cardH = CARD_HEIGHT_DP
    val handStepY = if (handCount <= 1) 0f
        else min(cardH * 0.72f, (usableH - cardH) / (handCount - 1).coerceAtLeast(1))

    val out = ArrayList<PlacedCard>()

    hands.forEachIndexed { hi, hand ->
        val size = hand.size
        val scale = maxOf(0.82f, 1f - hi * 0.10f)
        val cardW = min(185f, viewportW * 0.50f) * scale
        val R = 380f * scale
        val baseY = viewportH - bottomPad - hi * handStepY
        val pivotY = baseY + R
        val maxDeg = if (size == 1) 0f else min(14f, 3.5f * (size - 1))
        val step = if (size > 1) (2 * maxDeg) / (size - 1) else 0f
        val mid = (size - 1) / 2f
        val slotOrder = apexFirstIndices(size)
        val cx = viewportW / 2f

        for (k in 0 until size) {
            val slot = slotOrder[k]
            val thetaDeg = -maxDeg + slot * step
            val theta = thetaDeg * Math.PI.toFloat() / 180f
            val bx = cx + R * sin(theta.toDouble()).toFloat()
            val by = pivotY - R * cos(theta.toDouble()).toFloat()
            out.add(
                PlacedCard(
                    musician = hand[k],
                    xCenterPx = bx,
                    yBottomPx = by,
                    widthPx = cardW,
                    rotationDeg = thetaDeg,
                    z = (handCount - hi) * 100f + (size - k),
                    hand = hi,
                )
            )
        }
    }
    return out
}

@Composable
fun FanOfCards(
    musicians: List<Musician>,
    deckOffset: Int,
    onRotate: () -> Unit,
    onTap: (Musician) -> Unit,
    modifier: Modifier = Modifier,
) {
    BoxWithConstraints(
        modifier
            .fillMaxSize()
            .pointerInput(musicians.size) {
                detectHorizontalDragGestures { _, dragAmount ->
                    if (abs(dragAmount) > 12f) onRotate()
                }
            }
    ) {
        val density = LocalDensity.current
        val wPx = with(density) { maxWidth.toPx() }
        val hPx = with(density) { maxHeight.toPx() }
        val cards = remember(musicians.size, deckOffset, wPx, hPx) {
            layoutFan(musicians, deckOffset, wPx, hPx)
        }

        cards.forEach { c ->
            val xDp = with(density) { (c.xCenterPx - c.widthPx / 2f).toDp() }
            val yDp = with(density) { (c.yBottomPx - CARD_HEIGHT_DP).toDp() }
            val wDp = with(density) { c.widthPx.toDp() }
            Box(
                modifier = Modifier
                    .offset(x = xDp, y = yDp)
                    .size(width = wDp, height = CARD_HEIGHT_DP.dp)
                    .zIndex(c.z)
                    .graphicsLayer {
                        rotationZ = c.rotationDeg
                        transformOrigin = TransformOrigin(0.5f, 1f)
                    }
                    .pointerInput(c.musician) {
                        detectTapGestures(onTap = { onTap(c.musician) })
                    }
            ) {
                MusicianCard(c.musician, Modifier.fillMaxSize())
            }
        }
    }
}
