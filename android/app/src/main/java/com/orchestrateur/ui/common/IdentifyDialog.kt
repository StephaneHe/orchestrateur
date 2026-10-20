package com.orchestrateur.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.orchestrateur.data.IdInfo
import com.orchestrateur.data.IdLinkTarget
import com.orchestrateur.data.enc
import com.orchestrateur.data.fmtIdDate
import com.orchestrateur.data.getJson
import com.orchestrateur.data.parseIdentify
import com.orchestrateur.ui.theme.Palette

/**
 * Overlay that explains an identifier (0.107.0, web #idref-overlay):
 * GET /api/identify?id=&kind=&project=. Closed by ✕, back or a tap outside.
 */
@Composable
fun IdentifyDialog(kind: String?, value: String, project: String?, onDismiss: () -> Unit) {
    val env = LocalEnv.current
    val load = rememberLoad(kind, value, project) {
        val q = buildString {
            append("/api/identify?id=").append(enc(value))
            if (!kind.isNullOrEmpty()) append("&kind=").append(enc(kind))
            if (!project.isNullOrEmpty()) append("&project=").append(enc(project))
        }
        val r = env.api.getJson(q)
        when {
            r.code == 404 -> unreachable(value, "route absente : le serveur n’a pas encore été redémarré sur une version qui explique les identifiants (0.107.0 ou plus)")
            !r.ok || r.json == null -> unreachable(value, r.errorText())
            else -> parseIdentify(r.json, value)
        }
    }
    Dialog(onDismissRequest = onDismiss) {
        val shape = RoundedCornerShape(12.dp)
        Column(
            Modifier.widthIn(max = 560.dp).fillMaxWidth()
                .background(Palette.Bg2, shape).border(1.dp, Palette.CardBorder, shape)
                .padding(14.dp),
        ) {
            val info = load.value
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(
                        info?.kindLabel ?: "Identifiant",
                        color = if (info != null && !info.known) Palette.StError else Palette.Fg2, fontSize = 11.sp,
                    )
                    Text(info?.title ?: value, color = Palette.Fg0, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                }
                Box(
                    Modifier.heightIn(min = 44.dp).clickable { onDismiss() }.padding(horizontal = 12.dp, vertical = 10.dp),
                ) { Text("✕", color = Palette.Fg1, fontSize = 16.sp) }
            }
            Column(Modifier.verticalScroll(rememberScrollState()).padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                when {
                    info == null && load.error != null -> Text("⚠ ${load.error}", color = Palette.StError, fontSize = 13.sp)
                    info == null -> Text("Recherche de ce que désigne « $value »…", color = Palette.Fg2, fontSize = 13.sp)
                    !info.known -> {
                        Text("⚠ Identifiant inconnu", color = Palette.StError, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Text(info.message.orEmpty(), color = Palette.Fg1, fontSize = 13.sp)
                    }
                    else -> IdBody(info, onDismiss)
                }
            }
        }
    }
}

private fun unreachable(id: String, why: String) =
    IdInfo(id = id, known = false, kindLabel = "Identifiant inconnu", title = id,
        message = "Impossible de demander au serveur ce que désigne « $id » : $why.")

private fun toneColor(tone: String): Color = when (tone) {
    "ok" -> Palette.StLive
    "live" -> Palette.StThink
    "todo" -> Palette.StUnread
    "bad" -> Palette.StError
    "muted" -> Palette.Fg3
    else -> Palette.Fg1
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun IdBody(info: IdInfo, onDismiss: () -> Unit) {
    val env = LocalEnv.current
    Text(info.id, color = Palette.Fg1, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
        modifier = Modifier.background(Color.White.copy(alpha = 0.06f), RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 2.dp))
    if (info.state != null || info.project != null || info.date != null) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            info.state?.let { Tag(it, toneColor(info.tone)) }
            info.project?.let { Tag(it) }
            info.date?.let { Tag(fmtIdDate(it), Palette.Fg2) }
        }
    }
    info.summary?.takeIf { it.isNotBlank() }?.let { Text(it, color = Palette.Fg0, fontSize = 13.sp, lineHeight = 19.sp) }
    if (info.fields.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        for ((k, v) in info.fields) Row {
            Text(k, color = Palette.Fg2, fontSize = 12.sp, modifier = Modifier.widthIn(min = 96.dp, max = 140.dp).padding(end = 8.dp))
            Text(v, color = Palette.Fg0, fontSize = 12.sp, modifier = Modifier.weight(1f))
        }
    }
    if (info.links.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for ((label, target) in info.links) PillButton(label) {
            onDismiss()
            when (target) {
                is IdLinkTarget.Musician -> env.openMusician(target.name)
                is IdLinkTarget.Route -> env.navigate(target.route)
            }
        }
    }
}
